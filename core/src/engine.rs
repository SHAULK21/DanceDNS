//! Query pipeline: process attribution → rules → cache/upstream → response + log entry.

use crate::cache::DnsCache;
use crate::config::{ActionKind, Config};
use crate::dnsmsg::{self, AnswerView};
use crate::process::{ProcessInfo, ProcessTracker, Proto};
use crate::rules::RuleEngine;
use crate::upstream::{query_plain, Upstreams};
use anyhow::Result;
use bytes::Bytes;
use hickory_proto::op::{Message, ResponseCode};
use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use std::collections::VecDeque;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

const LOG_CAP: usize = 3000;

pub struct Runtime {
    pub config: Config,
    pub rules: RuleEngine,
    pub upstreams: Upstreams,
    pub cache: DnsCache,
}

impl Runtime {
    pub fn build(config: Config, previous: Option<&Runtime>) -> Result<Self> {
        let upstreams = Upstreams::build(
            &config.servers,
            &config.pools,
            previous.map(|p| (&p.upstreams, p.config.servers.as_slice())),
        )?;
        Ok(Self {
            rules: RuleEngine::new(&config.rules, &config.default_pool),
            cache: DnsCache::new(config.cache.max_entries, config.cache.min_ttl, config.cache.max_ttl),
            upstreams,
            config,
        })
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct LogEntry {
    pub seq: u64,
    /// unix ms
    pub ts: u64,
    pub client: String,
    pub transport: &'static str,
    pub pid: Option<u32>,
    pub process: String,
    pub process_path: String,
    pub domain: String,
    pub qtype: String,
    pub rule: String,
    pub action: ActionKind,
    pub pool: String,
    pub upstream: String,
    pub status: &'static str,
    pub rcode: String,
    pub latency_ms: f64,
    pub answers: Vec<AnswerView>,
    pub dnssec: bool,
    pub error: Option<String>,
}

#[derive(Default, Serialize, Clone)]
pub struct Counters {
    pub total: u64,
    pub resolved: u64,
    pub cached: u64,
    pub blocked: u64,
    pub local: u64,
    pub direct: u64,
    pub errors: u64,
}

pub struct Engine {
    pub runtime: RwLock<Arc<Runtime>>,
    pub tracker: ProcessTracker,
    pub config_path: PathBuf,
    pub started: Instant,
    log: Mutex<VecDeque<LogEntry>>,
    seq: AtomicU64,
    counters: Mutex<Counters>,
}

pub struct Origin {
    pub client: SocketAddr,
    pub proto: Proto,
    /// Local port the query arrived on (for TCP connection lookup).
    pub server_port: u16,
    /// Overrides process attribution (used by the "test" feature in the UI).
    pub forced_process: Option<ProcessInfo>,
    pub transport_label: &'static str,
}

impl Engine {
    pub fn new(config: Config, config_path: PathBuf) -> Result<Arc<Self>> {
        let rt = Runtime::build(config, None)?;
        Ok(Arc::new(Self {
            runtime: RwLock::new(Arc::new(rt)),
            tracker: ProcessTracker::new(),
            config_path,
            started: Instant::now(),
            log: Mutex::new(VecDeque::with_capacity(LOG_CAP)),
            seq: AtomicU64::new(0),
            counters: Mutex::new(Counters::default()),
        }))
    }

    pub fn rt(&self) -> Arc<Runtime> {
        self.runtime.read().clone()
    }

    /// Validate, save and hot-apply a new config.
    pub fn apply_config(&self, cfg: Config) -> Result<()> {
        cfg.validate()?;
        let old = self.rt();
        let new = Runtime::build(cfg, Some(&old))?;
        new.config.save(&self.config_path)?;
        *self.runtime.write() = Arc::new(new);
        Ok(())
    }

    pub fn counters(&self) -> Counters {
        self.counters.lock().clone()
    }

    pub fn logs_after(&self, after: u64, limit: usize) -> Vec<LogEntry> {
        let log = self.log.lock();
        log.iter().filter(|e| e.seq > after).rev().take(limit).cloned().collect::<Vec<_>>().into_iter().rev().collect()
    }

    pub fn clear_logs(&self) {
        self.log.lock().clear();
        *self.counters.lock() = Counters::default();
    }

    /// Handle one wire-format DNS query. Returns the response to send (None = drop).
    pub async fn handle(&self, packet: &[u8], origin: Origin) -> (Option<Bytes>, Option<LogEntry>) {
        let start = Instant::now();
        let Ok(query) = Message::from_vec(packet) else { return (None, None) };
        let Some(q) = query.queries().first().cloned() else {
            return (Some(dnsmsg::synthesize_rcode(&query, ResponseCode::FormErr)), None);
        };
        let domain = q.name().to_utf8();
        let qtype = q.query_type().to_string();

        let proc = match origin.forced_process {
            Some(p) => Some(p),
            None => {
                let (client, proto, sp) = (origin.client, origin.proto, origin.server_port);
                // the OS socket tables are read on a blocking-capable thread
                tokio::task::block_in_place(|| self.tracker.find(&client, proto, sp))
            }
        };

        let rt = self.rt();
        let m = rt.rules.evaluate(
            proc.as_ref().map(|p| p.name.as_str()),
            proc.as_ref().map(|p| p.path.as_str()),
            &domain,
            &qtype,
        );

        let mut upstream = String::new();
        let mut error = None;
        let status: &'static str;

        let response: Bytes = match m.action {
            ActionKind::Block => {
                status = "blocked";
                match m.sinkhole.as_deref().and_then(|s| s.parse::<IpAddr>().ok()) {
                    Some(ip) => dnsmsg::synthesize_ip(&query, ip, 60),
                    None => dnsmsg::synthesize_rcode(&query, ResponseCode::NXDomain),
                }
            }
            ActionKind::Local => {
                status = "local";
                match m.ip.parse::<IpAddr>() {
                    Ok(ip) => dnsmsg::synthesize_ip(&query, ip, 300),
                    Err(_) => dnsmsg::servfail(&query),
                }
            }
            ActionKind::Route | ActionKind::Direct => {
                let pool_key = if m.action == ActionKind::Direct { "@direct".to_string() } else { m.pool.clone() };
                let do_bit = query.extensions().as_ref().map(|e| e.dnssec_ok()).unwrap_or(false);
                let key = format!("{}|{}|{}|{:?}|{}", pool_key, domain.to_lowercase(), qtype, q.query_class(), do_bit);
                let cached = if rt.config.cache.enabled { rt.cache.get(&key) } else { None };
                if let Some(c) = cached {
                    status = "cached";
                    upstream = "cache".into();
                    dnsmsg::set_id(&c, query.id())
                } else {
                    let res = if m.action == ActionKind::Direct {
                        match rt.config.direct_dns.parse::<SocketAddr>() {
                            Ok(addr) => query_plain(addr, packet).await.map(|b| (b, addr.to_string())),
                            Err(e) => Err(e.into()),
                        }
                    } else {
                        match rt.upstreams.pools.get(&m.pool) {
                            Some(pool) => {
                                // RFC 8484 §4.1: use ID 0 for cache friendliness
                                let mut wire = packet.to_vec();
                                wire[0] = 0;
                                wire[1] = 0;
                                pool.query(&wire).await
                            }
                            None => Err(anyhow::anyhow!("пул '{}' не найден", m.pool)),
                        }
                    };
                    match res {
                        Ok((resp, from)) => {
                            status = if m.action == ActionKind::Direct { "direct" } else { "resolved" };
                            upstream = from;
                            let resp = dnsmsg::set_id(&resp, query.id());
                            if rt.config.cache.enabled {
                                if let Some(ttl) = dnsmsg::inspect(&resp).and_then(|i| i.cache_ttl) {
                                    rt.cache.insert(key, resp.clone(), ttl);
                                }
                            }
                            resp
                        }
                        Err(e) => {
                            status = "error";
                            error = Some(format!("{e:#}"));
                            dnsmsg::servfail(&query)
                        }
                    }
                }
            }
        };

        let info = dnsmsg::inspect(&response);
        let response = if origin.proto == Proto::Udp { dnsmsg::fit_udp(&query, response) } else { response };

        let entry = LogEntry {
            seq: self.seq.fetch_add(1, Ordering::Relaxed) + 1,
            ts: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0),
            client: origin.client.to_string(),
            transport: origin.transport_label,
            pid: proc.as_ref().map(|p| p.pid),
            process: proc.as_ref().map(|p| p.name.clone()).unwrap_or_else(|| "неизвестно".into()),
            process_path: proc.as_ref().map(|p| p.path.clone()).unwrap_or_default(),
            domain: domain.trim_end_matches('.').to_string(),
            qtype,
            rule: m.rule,
            action: m.action,
            pool: if m.action == ActionKind::Route { m.pool } else { String::new() },
            upstream,
            status,
            rcode: info.as_ref().map(|i| i.rcode.clone()).unwrap_or_default(),
            latency_ms: (start.elapsed().as_micros() as f64) / 1000.0,
            answers: info.as_ref().map(|i| i.answers.clone()).unwrap_or_default(),
            dnssec: info.as_ref().map(|i| i.dnssec_ad).unwrap_or(false),
            error,
        };
        if status == "error" {
            tracing::warn!("{} {} [{}]: {}", entry.domain, entry.qtype, entry.process, entry.error.as_deref().unwrap_or(""));
        } else {
            tracing::debug!("{} {} [{}] → {} ({})", entry.domain, entry.qtype, entry.process, entry.status, entry.rule);
        }
        {
            let mut c = self.counters.lock();
            c.total += 1;
            match status {
                "resolved" => c.resolved += 1,
                "cached" => c.cached += 1,
                "blocked" => c.blocked += 1,
                "local" => c.local += 1,
                "direct" => c.direct += 1,
                _ => c.errors += 1,
            }
        }
        {
            let mut log = self.log.lock();
            if log.len() >= LOG_CAP {
                log.pop_front();
            }
            log.push_back(entry.clone());
        }
        (Some(response), Some(entry))
    }
}
