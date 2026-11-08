//! Local DNS listeners (UDP + TCP).

use crate::engine::{Engine, Origin};
use crate::process::Proto;
use anyhow::{Context, Result};
use parking_lot::Mutex;
use serde::Serialize;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, UdpSocket};

#[derive(Serialize, Clone)]
pub struct ListenerStatus {
    pub addr: String,
    pub udp: bool,
    pub tcp: bool,
    pub error: Option<String>,
}

pub type ListenerState = Arc<Mutex<Vec<ListenerStatus>>>;

pub async fn start(engine: Arc<Engine>, addrs: &[String]) -> ListenerState {
    let state: ListenerState = Arc::new(Mutex::new(Vec::new()));
    for a in addrs {
        let mut st = ListenerStatus { addr: a.clone(), udp: false, tcp: false, error: None };
        match a.parse::<SocketAddr>() {
            Err(e) => st.error = Some(e.to_string()),
            Ok(addr) => {
                match bind_udp(addr).await {
                    Ok(sock) => {
                        st.udp = true;
                        tokio::spawn(run_udp(engine.clone(), Arc::new(sock), addr.port()));
                    }
                    Err(e) => st.error = Some(format!("UDP: {e:#}")),
                }
                match TcpListener::bind(addr).await {
                    Ok(l) => {
                        st.tcp = true;
                        tokio::spawn(run_tcp(engine.clone(), l, addr.port()));
                    }
                    Err(e) => {
                        let msg = format!("TCP: {e}");
                        st.error = Some(match st.error.take() { Some(p) => format!("{p}; {msg}"), None => msg });
                    }
                }
            }
        }
        if let Some(e) = &st.error {
            tracing::error!("не удалось открыть {}: {}", a, e);
        } else {
            tracing::info!("DNS слушает {} (UDP+TCP)", a);
        }
        state.lock().push(st);
    }
    state
}

async fn bind_udp(addr: SocketAddr) -> Result<UdpSocket> {
    let sock = UdpSocket::bind(addr).await.with_context(|| format!("bind {addr}"))?;
    #[cfg(windows)]
    disable_connreset(&sock);
    Ok(sock)
}

/// Without this, an ICMP "port unreachable" from a client that already went away makes
/// recv_from() on Windows fail with WSAECONNRESET.
#[cfg(windows)]
fn disable_connreset(sock: &UdpSocket) {
    use std::os::windows::io::AsRawSocket;
    use windows_sys::Win32::Networking::WinSock::{WSAIoctl, SIO_UDP_CONNRESET};
    let mut off: u32 = 0;
    let mut ret: u32 = 0;
    unsafe {
        WSAIoctl(
            sock.as_raw_socket() as usize,
            SIO_UDP_CONNRESET,
            &mut off as *mut _ as *mut _,
            4,
            std::ptr::null_mut(),
            0,
            &mut ret,
            std::ptr::null_mut(),
            None,
        );
    }
}

async fn run_udp(engine: Arc<Engine>, sock: Arc<UdpSocket>, port: u16) {
    let mut buf = vec![0u8; 4096];
    loop {
        let (n, src) = match sock.recv_from(&mut buf).await {
            Ok(v) => v,
            Err(e) => {
                tracing::debug!("UDP recv: {e}");
                tokio::time::sleep(Duration::from_millis(5)).await;
                continue;
            }
        };
        let packet = buf[..n].to_vec();
        let engine = engine.clone();
        let sock = sock.clone();
        tokio::spawn(async move {
            let origin = Origin { client: src, proto: Proto::Udp, server_port: port, forced_process: None, transport_label: "udp" };
            if let (Some(resp), _) = engine.handle(&packet, origin).await {
                let _ = sock.send_to(&resp, src).await;
            }
        });
    }
}

async fn run_tcp(engine: Arc<Engine>, listener: TcpListener, port: u16) {
    loop {
        let (mut stream, src) = match listener.accept().await {
            Ok(v) => v,
            Err(e) => {
                tracing::debug!("TCP accept: {e}");
                tokio::time::sleep(Duration::from_millis(20)).await;
                continue;
            }
        };
        let engine = engine.clone();
        tokio::spawn(async move {
            loop {
                let mut len = [0u8; 2];
                match tokio::time::timeout(Duration::from_secs(10), stream.read_exact(&mut len)).await {
                    Ok(Ok(_)) => {}
                    _ => return,
                }
                let n = u16::from_be_bytes(len) as usize;
                let mut packet = vec![0u8; n];
                if tokio::time::timeout(Duration::from_secs(10), stream.read_exact(&mut packet)).await.ok().and_then(|r| r.ok()).is_none() {
                    return;
                }
                let origin = Origin { client: src, proto: Proto::Tcp, server_port: port, forced_process: None, transport_label: "tcp" };
                let Some(resp) = engine.handle(&packet, origin).await.0 else { return };
                let mut out = Vec::with_capacity(resp.len() + 2);
                out.extend_from_slice(&(resp.len() as u16).to_be_bytes());
                out.extend_from_slice(&resp);
                if stream.write_all(&out).await.is_err() {
                    return;
                }
            }
        });
    }
}
