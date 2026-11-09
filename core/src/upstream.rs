//! Upstream clients (DNS-over-HTTPS RFC 8484, DNS-over-QUIC RFC 9250) and pools.

use crate::config::{PoolConfig, PoolStrategy, ServerConfig};
use anyhow::{anyhow, bail, Context, Result};
use bytes::Bytes;
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::net::UdpSocket;

pub struct Upstream {
    pub id: String,
    pub name: String,
    pub url: String,
    transport: Transport,
    /// Smoothed latency in microseconds, 0 = not measured yet.
    ewma_us: AtomicU64,
    ok: AtomicU64,
    fail: AtomicU64,
    last_ok: AtomicBool,
    last_error: Mutex<Option<String>>,
}

#[derive(Serialize, Clone)]
pub struct UpstreamStats {
    pub id: String,
    pub name: String,
    pub url: String,
    pub protocol: &'static str,
    pub latency_ms: Option<f64>,
    pub healthy: bool,
    pub ok: u64,
    pub fail: u64,
    pub last_error: Option<String>,
}

enum Transport {
    Doh(reqwest::Client),
    Doq(crate::doq::DoqClient),
}

impl Upstream {
    pub fn protocol(&self) -> &'static str {
        match self.transport {
            Transport::Doh(_) => "DoH",
            Transport::Doq(_) => "DoQ",
        }
    }

    pub fn new(cfg: &ServerConfig) -> Result<Self> {
        let url = url::Url::parse(&cfg.url)?;
        if url.scheme() == "quic" {
            return Ok(Self::with_transport(cfg, Transport::Doq(crate::doq::DoqClient::new(&url, &cfg.bootstrap, cfg.timeout_ms)?)));
        }
        let host = url.host_str().ok_or_else(|| anyhow!("в URL нет хоста"))?.to_string();
        let port = url.port_or_known_default().unwrap_or(443);
        let mut b = reqwest::Client::builder()
            .use_rustls_tls()
            .timeout(Duration::from_millis(cfg.timeout_ms.max(500)))
            .connect_timeout(Duration::from_millis(cfg.timeout_ms.max(500)))
            .pool_idle_timeout(Duration::from_secs(90))
            .pool_max_idle_per_host(8)
            .tcp_keepalive(Duration::from_secs(30))
            .user_agent(concat!("DanceDNS/", env!("CARGO_PKG_VERSION")))
            .no_proxy();
        // Optional extra root CA (corporate TLS inspection etc.): DANCEDNS_EXTRA_CA=path.pem
        if let Some(path) = std::env::var_os("DANCEDNS_EXTRA_CA") {
            let pem = std::fs::read(&path).with_context(|| format!("DANCEDNS_EXTRA_CA: {:?}", path))?;
            for cert in reqwest::Certificate::from_pem_bundle(&pem).context("DANCEDNS_EXTRA_CA: неверный PEM")? {
                b = b.add_root_certificate(cert);
            }
        }
        if host.parse::<IpAddr>().is_err() && !cfg.bootstrap.is_empty() {
            let addrs: Vec<SocketAddr> = cfg
                .bootstrap
                .iter()
                .filter_map(|ip| ip.parse::<IpAddr>().ok())
                .map(|ip| SocketAddr::new(ip, port))
                .collect();
            b = b.resolve_to_addrs(&host, &addrs);
        }
        let client = b.build().context("не удалось создать HTTP клиент")?;
        Ok(Self::with_transport(cfg, Transport::Doh(client)))
    }

    fn with_transport(cfg: &ServerConfig, transport: Transport) -> Self {
        Self {
            id: cfg.id.clone(),
            name: if cfg.name.is_empty() { cfg.id.clone() } else { cfg.name.clone() },
            url: cfg.url.clone(),
            transport,
            ewma_us: AtomicU64::new(0),
            ok: AtomicU64::new(0),
            fail: AtomicU64::new(0),
            last_ok: AtomicBool::new(true),
            last_error: Mutex::new(None),
        }
    }

    /// Send a wire-format query, returns the wire-format response.
    pub async fn query(&self, packet: &[u8]) -> Result<Bytes> {
        let start = Instant::now();
        let res = self.query_inner(packet).await;
        match &res {
            Ok(_) => {
                let us = start.elapsed().as_micros() as u64;
                let old = self.ewma_us.load(Ordering::Relaxed);
                let new = if old == 0 { us } else { (old * 7 + us) / 8 };
                self.ewma_us.store(new.max(1), Ordering::Relaxed);
                self.ok.fetch_add(1, Ordering::Relaxed);
                self.last_ok.store(true, Ordering::Relaxed);
            }
            Err(e) => {
                self.fail.fetch_add(1, Ordering::Relaxed);
                self.last_ok.store(false, Ordering::Relaxed);
                // penalise so `fastest` prefers other servers for a while
                let old = self.ewma_us.load(Ordering::Relaxed);
                self.ewma_us.store(old.max(1).saturating_mul(2).min(10_000_000).max(2_000_000), Ordering::Relaxed);
                *self.last_error.lock() = Some(format!("{e:#}"));
            }
        }
        res
    }

    async fn query_inner(&self, packet: &[u8]) -> Result<Bytes> {
        let client = match &self.transport {
            Transport::Doq(c) => return c.query(packet).await.map_err(|e| anyhow!("{}: {e:#}", self.id)),
            Transport::Doh(c) => c,
        };
        let resp = client
            .post(&self.url)
            .header("content-type", "application/dns-message")
            .header("accept", "application/dns-message")
            .body(packet.to_vec())
            .send()
            .await
            .map_err(|e| anyhow!("{}: {}", self.id, describe_reqwest(&e)))?;
        if !resp.status().is_success() {
            bail!("{}: HTTP {}", self.id, resp.status());
        }
        let body = resp.bytes().await.map_err(|e| anyhow!("{}: {}", self.id, describe_reqwest(&e)))?;
        if body.len() < 12 {
            bail!("{}: слишком короткий ответ", self.id);
        }
        Ok(body)
    }

    pub fn latency_us(&self) -> u64 {
        self.ewma_us.load(Ordering::Relaxed)
    }

    pub fn stats(&self) -> UpstreamStats {
        let l = self.latency_us();
        UpstreamStats {
            id: self.id.clone(),
            name: self.name.clone(),
            url: self.url.clone(),
            protocol: self.protocol(),
            healthy: self.last_ok.load(Ordering::Relaxed),
            latency_ms: if l == 0 || !self.last_ok.load(Ordering::Relaxed) { None } else { Some(l as f64 / 1000.0) },
            ok: self.ok.load(Ordering::Relaxed),
            fail: self.fail.load(Ordering::Relaxed),
            last_error: self.last_error.lock().clone(),
        }
    }
}

fn describe_reqwest(e: &reqwest::Error) -> String {
    let mut s = e.to_string();
    let mut src = std::error::Error::source(e);
    while let Some(inner) = src {
        s.push_str(": ");
        s.push_str(&inner.to_string());
        src = inner.source();
    }
    if e.is_timeout() {
        s = format!("таймаут ({s})");
    }
    s
}

pub struct Pool {
    pub id: String,
    strategy: PoolStrategy,
    members: Vec<Arc<Upstream>>,
    rr: AtomicUsize,
}

impl Pool {
    /// Returns (response, id of upstream that answered).
    pub async fn query(&self, packet: &[u8]) -> Result<(Bytes, String)> {
        let order: Vec<&Arc<Upstream>> = match self.strategy {
            PoolStrategy::Failover => self.members.iter().collect(),
            PoolStrategy::RoundRobin => {
                let start = self.rr.fetch_add(1, Ordering::Relaxed) % self.members.len().max(1);
                self.members.iter().cycle().skip(start).take(self.members.len()).collect()
            }
            PoolStrategy::Fastest => {
                let mut v: Vec<&Arc<Upstream>> = self.members.iter().collect();
                // Unmeasured servers (0) are tried first so every member gets measured.
                v.sort_by_key(|u| u.latency_us());
                v
            }
        };
        let mut errors = Vec::new();
        for u in order {
            match u.query(packet).await {
                Ok(b) => return Ok((b, u.id.clone())),
                Err(e) => errors.push(format!("{e:#}")),
            }
        }
        Err(anyhow!("все серверы пула '{}' недоступны: {}", self.id, errors.join("; ")))
    }
}

pub struct Upstreams {
    pub servers: Vec<Arc<Upstream>>,
    pub pools: HashMap<String, Pool>,
}

impl Upstreams {
    /// Build pools, reusing existing upstream clients (keeps warm connections + stats)
    /// when a server's settings are unchanged.
    pub fn build(servers: &[ServerConfig], pools: &[PoolConfig], previous: Option<(&Upstreams, &[ServerConfig])>) -> Result<Self> {
        let mut built: HashMap<String, Arc<Upstream>> = HashMap::new();
        let mut list = Vec::new();
        for s in servers {
            let reuse = previous.and_then(|(prev, prev_cfg)| {
                let same = prev_cfg.iter().any(|p| p.id == s.id && p.url == s.url && p.bootstrap == s.bootstrap && p.timeout_ms == s.timeout_ms && p.name == s.name);
                if same { prev.servers.iter().find(|u| u.id == s.id).cloned() } else { None }
            });
            let u = match reuse {
                Some(u) => u,
                None => Arc::new(Upstream::new(s).with_context(|| format!("сервер {}", s.id))?),
            };
            built.insert(s.id.clone(), u.clone());
            list.push(u);
        }
        let mut map = HashMap::new();
        for p in pools {
            let members = p.servers.iter().filter_map(|id| built.get(id).cloned()).collect();
            map.insert(p.id.clone(), Pool { id: p.id.clone(), strategy: p.strategy, members, rr: AtomicUsize::new(0) });
        }
        Ok(Self { servers: list, pools: map })
    }
}

/// Plain DNS over UDP (used by the `direct` action).
pub async fn query_plain(server: SocketAddr, packet: &[u8]) -> Result<Bytes> {
    let bind: SocketAddr = if server.is_ipv4() { "0.0.0.0:0".parse()? } else { "[::]:0".parse()? };
    let sock = UdpSocket::bind(bind).await?;
    sock.connect(server).await?;
    let mut buf = vec![0u8; 4096];
    for _ in 0..2 {
        sock.send(packet).await?;
        if let Ok(r) = tokio::time::timeout(Duration::from_millis(2000), sock.recv(&mut buf)).await {
            let n = r?;
            if n >= 2 && buf[..2] == packet[..2] {
                return Ok(Bytes::copy_from_slice(&buf[..n]));
            }
        }
    }
    bail!("нет ответа от {server}")
}
