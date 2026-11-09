//! DNS-over-QUIC client (RFC 9250).
//!
//! One QUIC connection per server is kept open and reused; every query is sent on its own
//! bidirectional stream as a 2-byte length-prefixed DNS message with ID 0.

use anyhow::{anyhow, bail, Context, Result};
use bytes::Bytes;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

pub struct DoqClient {
    host: String,
    addrs: Vec<SocketAddr>,
    timeout: Duration,
    config: quinn::ClientConfig,
    state: Mutex<Option<(quinn::Endpoint, quinn::Connection)>>,
}

/// Root store: bundled Mozilla roots plus optional DANCEDNS_EXTRA_CA (PEM).
pub fn root_store() -> Result<rustls::RootCertStore> {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    if let Some(path) = std::env::var_os("DANCEDNS_EXTRA_CA") {
        let pem = std::fs::read(&path).with_context(|| format!("DANCEDNS_EXTRA_CA: {:?}", path))?;
        for cert in rustls_pemfile::certs(&mut pem.as_slice()) {
            let cert = cert.context("DANCEDNS_EXTRA_CA: неверный PEM")?;
            roots.add(cert).context("DANCEDNS_EXTRA_CA: сертификат не принят")?;
        }
    }
    Ok(roots)
}

impl DoqClient {
    pub fn new(url: &url::Url, bootstrap: &[String], timeout_ms: u64) -> Result<Self> {
        let host = url.host_str().ok_or_else(|| anyhow!("в URL нет хоста"))?.trim_matches(['[', ']']).to_string();
        let port = url.port().unwrap_or(853);
        let mut addrs: Vec<SocketAddr> = match host.parse::<IpAddr>() {
            Ok(ip) => vec![SocketAddr::new(ip, port)],
            Err(_) => bootstrap.iter().filter_map(|b| b.parse::<IpAddr>().ok()).map(|ip| SocketAddr::new(ip, port)).collect(),
        };
        if addrs.is_empty() {
            // resolved lazily through the system resolver
            addrs = Vec::new();
        }

        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let mut tls = rustls::ClientConfig::builder_with_provider(provider)
            .with_protocol_versions(&[&rustls::version::TLS13])?
            .with_root_certificates(root_store()?)
            .with_no_client_auth();
        tls.alpn_protocols = vec![b"doq".to_vec()];
        tls.enable_early_data = true;
        let qtls = quinn::crypto::rustls::QuicClientConfig::try_from(tls).map_err(|e| anyhow!("QUIC TLS: {e}"))?;
        let mut config = quinn::ClientConfig::new(Arc::new(qtls));
        let mut transport = quinn::TransportConfig::default();
        transport.max_idle_timeout(Some(Duration::from_secs(60).try_into().unwrap()));
        transport.keep_alive_interval(Some(Duration::from_secs(20)));
        config.transport_config(Arc::new(transport));

        Ok(Self { host, addrs, timeout: Duration::from_millis(timeout_ms.max(500)), config, state: Mutex::new(None) })
    }

    async fn connect(&self) -> Result<(quinn::Endpoint, quinn::Connection)> {
        let addrs = if self.addrs.is_empty() {
            tokio::net::lookup_host((self.host.as_str(), 853)).await?.collect::<Vec<_>>()
        } else {
            self.addrs.clone()
        };
        let mut last = anyhow!("нет адресов для {}", self.host);
        for addr in addrs {
            let bind: SocketAddr = if addr.is_ipv4() { "0.0.0.0:0".parse()? } else { "[::]:0".parse()? };
            let mut ep = quinn::Endpoint::client(bind)?;
            ep.set_default_client_config(self.config.clone());
            let connecting = match ep.connect(addr, &self.host) {
                Ok(c) => c,
                Err(e) => {
                    last = anyhow!("{addr}: {e}");
                    continue;
                }
            };
            match tokio::time::timeout(self.timeout, connecting).await {
                Ok(Ok(conn)) => return Ok((ep, conn)),
                Ok(Err(e)) => last = anyhow!("{addr}: {e}"),
                Err(_) => last = anyhow!("{addr}: таймаут QUIC-соединения"),
            }
        }
        Err(last)
    }

    async fn connection(&self, fresh: bool) -> Result<quinn::Connection> {
        let mut st = self.state.lock().await;
        if let Some((_, c)) = st.as_ref() {
            if !fresh && c.close_reason().is_none() {
                return Ok(c.clone());
            }
        }
        let (ep, conn) = self.connect().await?;
        *st = Some((ep, conn.clone()));
        Ok(conn)
    }

    async fn exchange(conn: &quinn::Connection, wire: &[u8]) -> Result<Bytes> {
        let (mut send, mut recv) = conn.open_bi().await.context("open stream")?;
        let mut msg = Vec::with_capacity(wire.len() + 2);
        msg.extend_from_slice(&(wire.len() as u16).to_be_bytes());
        msg.extend_from_slice(wire);
        send.write_all(&msg).await.context("write")?;
        send.finish().context("finish")?;
        let data = recv.read_to_end(65537).await.context("read")?;
        if data.len() < 2 {
            bail!("пустой ответ");
        }
        let n = u16::from_be_bytes([data[0], data[1]]) as usize;
        if data.len() < 2 + n || n < 12 {
            bail!("обрезанный ответ");
        }
        Ok(Bytes::copy_from_slice(&data[2..2 + n]))
    }

    pub async fn query(&self, packet: &[u8]) -> Result<Bytes> {
        // RFC 9250 §4.2.1: the DNS Message ID MUST be 0.
        let mut wire = packet.to_vec();
        if wire.len() >= 2 {
            wire[0] = 0;
            wire[1] = 0;
        }
        let first = async {
            let conn = self.connection(false).await?;
            Self::exchange(&conn, &wire).await
        };
        match tokio::time::timeout(self.timeout, first).await {
            Ok(Ok(b)) => Ok(b),
            // The idle connection may have been dropped by the server: retry once on a new one.
            _ => {
                let retry = async {
                    let conn = self.connection(true).await?;
                    Self::exchange(&conn, &wire).await
                };
                tokio::time::timeout(self.timeout, retry).await.map_err(|_| anyhow!("таймаут"))?
            }
        }
    }
}
