//! Catch-all DNS interception with WinDivert.
//!
//! Captures every outgoing UDP packet to port 53 that does NOT go to DanceDNS itself — programs
//! with hard-coded servers (8.8.8.8 …), IPv6 router DNS, VPN adapters — resolves it through
//! DanceDNS (rules, DoQ/DoH) and injects the answer back as if it came from the original server.
//!
//! WinDivert.dll and the signed WinDivert64.sys driver are embedded in the exe and extracted next
//! to it on first use.

use crate::engine::{Engine, Origin};
use crate::packet::{build_reply, parse};
use crate::process::Proto;
use anyhow::{anyhow, bail, Result};
use parking_lot::Mutex;
use std::ffi::c_void;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;

static DLL: &[u8] = include_bytes!("../vendor/windivert/WinDivert.dll");
static SYS: &[u8] = include_bytes!("../vendor/windivert/WinDivert64.sys");

const FILTER: &str = "outbound and !loopback and !impostor and udp.DstPort == 53";
const OUTBOUND_BIT: u32 = 1 << 17;

#[repr(C)]
#[derive(Clone, Copy)]
struct Addr {
    timestamp: i64,
    flags: u32,
    reserved2: u32,
    data: [u8; 64],
}

type Handle = isize;
type OpenFn = unsafe extern "C" fn(*const u8, i32, i16, u64) -> Handle;
type RecvFn = unsafe extern "C" fn(Handle, *mut c_void, u32, *mut u32, *mut Addr) -> i32;
type SendFn = unsafe extern "C" fn(Handle, *const c_void, u32, *mut u32, *const Addr) -> i32;
type CloseFn = unsafe extern "C" fn(Handle) -> i32;
type ShutdownFn = unsafe extern "C" fn(Handle, u32) -> i32;
type ChecksumFn = unsafe extern "C" fn(*mut c_void, u32, *mut Addr, u64) -> i32;

#[derive(Clone, Copy)]
struct Api {
    open: OpenFn,
    recv: RecvFn,
    send: SendFn,
    close: CloseFn,
    shutdown: ShutdownFn,
    checksum: ChecksumFn,
}

struct Running {
    api: Api,
    handle: Handle,
}

static STATE: Mutex<Option<Running>> = Mutex::new(None);

pub fn is_running() -> bool {
    STATE.lock().is_some()
}

fn extract(dir: &Path) -> Result<std::path::PathBuf> {
    for (name, bytes) in [("WinDivert.dll", DLL), ("WinDivert64.sys", SYS)] {
        let p = dir.join(name);
        let same = std::fs::read(&p).map(|b| b == bytes).unwrap_or(false);
        if !same {
            std::fs::write(&p, bytes).map_err(|e| anyhow!("не удалось записать {}: {e}", p.display()))?;
        }
    }
    Ok(dir.join("WinDivert.dll"))
}

unsafe fn load(dll: &Path) -> Result<Api> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
    let w: Vec<u16> = dll.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let m = LoadLibraryW(w.as_ptr());
    if m == 0 {
        bail!("не удалось загрузить WinDivert.dll");
    }
    macro_rules! sym {
        ($n:literal) => {{
            let f = GetProcAddress(m, concat!($n, "\0").as_ptr()).ok_or_else(|| anyhow!(concat!("нет функции ", $n)))?;
            std::mem::transmute(f)
        }};
    }
    Ok(Api {
        open: sym!("WinDivertOpen"),
        recv: sym!("WinDivertRecv"),
        send: sym!("WinDivertSend"),
        close: sym!("WinDivertClose"),
        shutdown: sym!("WinDivertShutdown"),
        checksum: sym!("WinDivertHelperCalcChecksums"),
    })
}

pub fn start(engine: Arc<Engine>, rt: tokio::runtime::Handle, dir: &Path) -> Result<()> {
    let mut st = STATE.lock();
    if st.is_some() {
        return Ok(());
    }
    let dll = extract(dir)?;
    let api = unsafe { load(&dll)? };
    let filter = format!("{FILTER}\0");
    let handle = unsafe { (api.open)(filter.as_ptr(), 0, 0, 0) };
    if handle == -1 {
        let code = unsafe { windows_sys::Win32::Foundation::GetLastError() };
        bail!(
            "WinDivert не запустился (код {code}). {}",
            match code {
                5 => "Нужны права администратора.",
                577 | 1275 => "Windows не разрешила загрузить драйвер (проверьте антивирус / Secure Boot политику).",
                2 => "Не найден WinDivert64.sys рядом с программой.",
                _ => "",
            }
        );
    }
    *st = Some(Running { api, handle });
    drop(st);
    std::thread::Builder::new()
        .name("windivert".into())
        .spawn(move || recv_loop(api, handle, engine, rt))?;
    tracing::info!("перехват DNS (WinDivert) включён");
    Ok(())
}

pub fn stop() {
    if let Some(r) = STATE.lock().take() {
        unsafe {
            (r.api.shutdown)(r.handle, 3);
            (r.api.close)(r.handle);
        }
        tracing::info!("перехват DNS (WinDivert) выключен");
    }
}

fn recv_loop(api: Api, handle: Handle, engine: Arc<Engine>, rt: tokio::runtime::Handle) {
    let own_pid = std::process::id();
    let mut buf = vec![0u8; 65535];
    loop {
        let mut len = 0u32;
        let mut addr: Addr = unsafe { std::mem::zeroed() };
        let ok = unsafe { (api.recv)(handle, buf.as_mut_ptr() as *mut _, buf.len() as u32, &mut len, &mut addr) };
        if ok == 0 {
            let code = unsafe { windows_sys::Win32::Foundation::GetLastError() };
            // 232 ERROR_NO_DATA / 6 ERROR_INVALID_HANDLE: handle shut down
            if code == 232 || code == 6 || code == 995 || !is_running() {
                return;
            }
            continue;
        }
        let packet = buf[..len as usize].to_vec();
        let reinject = move |p: &[u8], a: &Addr| unsafe {
            (api.send)(handle, p.as_ptr() as *const _, p.len() as u32, std::ptr::null_mut(), a);
        };
        let Some(q) = parse(&packet) else {
            reinject(&packet, &addr);
            continue;
        };
        let client = SocketAddr::new(q.src, q.sport);
        // our own "direct" queries must go out untouched
        if engine.tracker.find(&client, Proto::Udp, q.dport).map(|p| p.pid) == Some(own_pid) {
            reinject(&packet, &addr);
            continue;
        }
        let engine = engine.clone();
        rt.spawn(async move {
            let origin = Origin { client, proto: Proto::Udp, server_port: q.dport, forced_process: None, transport_label: "intercept" };
            match engine.handle(&packet[q.payload.clone()], origin).await.0 {
                Some(dns) => {
                    let mut reply = build_reply(&q, &dns);
                    let mut a = addr;
                    a.flags &= !OUTBOUND_BIT;
                    unsafe {
                        (api.checksum)(reply.as_mut_ptr() as *mut _, reply.len() as u32, &mut a, 0);
                    }
                    reinject(&reply, &a);
                }
                None => reinject(&packet, &addr),
            }
        });
    }
}
