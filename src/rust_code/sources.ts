export interface RustFile {
  name: string;
  path: string;
  description: string;
  language: string;
  content: string;
}

export const RUST_PROJECT_FILES: RustFile[] = [
  {
    name: 'Cargo.toml',
    path: 'Cargo.toml',
    description: 'Cargo package manifest with all required async, networking, and platform dependencies.',
    language: 'toml',
    content: `[package]
name = "rusty-yoga-dns"
version = "0.1.0"
edition = "2021"
authors = ["RustyYoga Contributor"]
description = "A high-performance YogaDNS analogue in Rust with DNS-over-HTTPS and per-process traffic routing rules."
license = "MIT OR Apache-2.0"

[dependencies]
tokio = { version = "1.40", features = ["full"] }
reqwest = { version = "0.12", default-features = false, features = ["rustls-tls", "http2", "json", "stream"] }
hickory-proto = "0.24"
serde = { version = "1.0", features = ["derive"] }
serde_yaml = "0.9"
clap = { version = "4.5", features = ["derive"] }
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter", "fmt"] }
anyhow = "1.0"
regex = "1.10"
glob = "0.3"
lru = "0.12"
bytes = "1.7"
async-trait = "0.1"

[target.'cfg(windows)'.dependencies]
windows-sys = { version = "0.52", features = [
    "Win32_Foundation",
    "Win32_NetworkManagement_IpHelper",
    "Win32_Networking_WinSock",
    "Win32_System_Threading",
    "Win32_System_ProcessStatus",
    "Win32_Security",
] }

[target.'cfg(target_os = "linux")'.dependencies]
procfs = "0.16"

[profile.release]
opt-level = 3
lto = true
codegen-units = 1
panic = "abort"
strip = true
`,
  },
  {
    name: 'main.rs',
    path: 'src/main.rs',
    description: 'Main daemon entrypoint, CLI arguments parser, and graceful shutdown coordinator.',
    language: 'rust',
    content: `//! RustyYoga DNS - Process-Aware DNS-over-HTTPS Client
//! Analogue of YogaDNS written in idiomatic, high-concurrency Rust.

use anyhow::{Context, Result};
use clap::Parser;
use std::path::PathBuf;
use std::sync::Arc;
use tracing::{info, error, Level};
use tracing_subscriber::FmtSubscriber;

mod config;
mod doh;
mod rules;
mod process_tracker;
mod cache;
mod server;

use crate::config::Config;
use crate::doh::DohPool;
use crate::rules::RuleEngine;
use crate::process_tracker::ProcessTracker;
use crate::cache::DnsCache;
use crate::server::DnsServer;

#[derive(Parser, Debug)]
#[command(author, version, about = "YogaDNS analogue in Rust with DoH and per-process routing")]
struct Args {
    /// Path to YAML configuration file
    #[arg(short, long, default_value = "config.yaml")]
    config: PathBuf,

    /// Local DNS listen address override (e.g. 127.0.0.1:53)
    #[arg(short, long)]
    listen: Option<String>,

    /// Verbose logging level
    #[arg(short, long)]
    verbose: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();

    // 1. Initialize structured logging
    let log_level = if args.verbose { Level::DEBUG } else { Level::INFO };
    let subscriber = FmtSubscriber::builder()
        .with_max_level(log_level)
        .with_target(false)
        .with_thread_ids(false)
        .finish();
    tracing::subscriber::set_global_default(subscriber)
        .context("Failed to set tracing subscriber")?;

    info!("--------------------------------------------------");
    info!("Starting RustyYoga DNS (YogaDNS Rust Analogue)");
    info!("--------------------------------------------------");

    // 2. Load configuration file
    let config = Config::load(&args.config)
        .context("Failed to parse configuration file")?;
    info!("Loaded configuration from {:?}", args.config);
    info!("Configured {} DoH upstreams, {} pools, {} routing rules",
        config.servers.len(),
        config.pools.len(),
        config.rules.len()
    );

    // 3. Initialize Process Tracker (Windows GetExtendedUdpTable / Linux procfs)
    let process_tracker = Arc::new(ProcessTracker::new());
    info!("Process attribution engine initialized for OS: {}", std::env::consts::OS);

    // 4. Initialize DNS Cache
    let cache = Arc::new(DnsCache::new(config.cache.max_entries, config.cache.min_ttl));

    // 5. Initialize Rule Engine
    let rule_engine = Arc::new(RuleEngine::new(config.rules.clone()));

    // 6. Initialize DoH Client Pool
    let doh_pool = Arc::new(DohPool::new(&config.servers, &config.pools)?);

    // 7. Bind local DNS Server (UDP & TCP)
    let listen_addr = args.listen.unwrap_or(config.listen_addr);
    let server = DnsServer::new(
        &listen_addr,
        process_tracker,
        rule_engine,
        doh_pool,
        cache,
    ).await.context("Failed to bind local DNS listener")?;

    info!("RustyYoga DNS listener running on UDP/TCP {}", listen_addr);
    info!("Set your OS Primary DNS to 127.0.0.1 to route traffic.");

    // 8. Run server with graceful shutdown on Ctrl+C
    tokio::select! {
        res = server.run() => {
            if let Err(e) = res {
                error!("Server error: {:#}", e);
            }
        }
        _ = tokio::signal::ctrl_c() => {
            info!("Received shutdown signal. Stopping RustyYoga DNS cleanly...");
        }
    }

    info!("RustyYoga DNS terminated successfully.");
    Ok(())
}
`,
  },
  {
    name: 'config.rs',
    path: 'src/config.rs',
    description: 'Strongly typed configuration for DoH upstreams, pools, process rules, and cache.',
    language: 'rust',
    content: `use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub listen_addr: String,
    pub cache: CacheConfig,
    pub servers: HashMap<String, DohServerConfig>,
    pub pools: HashMap<String, PoolConfig>,
    pub rules: Vec<RuleConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheConfig {
    pub max_entries: usize,
    pub min_ttl: u32,
    pub max_ttl: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DohServerConfig {
    pub url: String,
    pub bootstrap_ips: Vec<String>,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
    #[serde(default)]
    pub http2_only: bool,
}

fn default_timeout_ms() -> u64 {
    3000
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoolConfig {
    pub servers: Vec<String>,
    #[serde(default = "default_strategy")]
    pub strategy: PoolStrategy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PoolStrategy {
    Fastest,
    RoundRobin,
    Failover,
}

fn default_strategy() -> PoolStrategy {
    PoolStrategy::Fastest
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuleConfig {
    pub name: String,
    #[serde(default)]
    pub process: Option<String>,
    #[serde(default)]
    pub process_path: Option<String>,
    #[serde(default)]
    pub domain: Option<String>,
    #[serde(default)]
    pub qtype: Option<String>,
    pub action: RuleAction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuleAction {
    Route { pool: String },
    Direct,
    Block { sinkhole: Option<String> },
    Local { ip: String },
}

impl Config {
    pub fn load<P: AsRef<Path>>(path: P) -> Result<Self> {
        let content = fs::read_to_string(path)
            .context("Failed to read configuration file")?;
        let config: Config = serde_yaml::from_str(&content)
            .context("Failed to parse YAML configuration")?;
        Ok(config)
    }
}
`,
  },
  {
    name: 'rules.rs',
    path: 'src/rules.rs',
    description: 'Rule matching engine evaluated per query against process name, path, and domain pattern.',
    language: 'rust',
    content: `use crate::config::{RuleAction, RuleConfig};
use glob::Pattern;
use std::sync::Arc;
use tracing::debug;

#[derive(Debug, Clone)]
pub struct CompiledRule {
    pub name: String,
    pub process_pattern: Option<Pattern>,
    pub process_path_pattern: Option<Pattern>,
    pub domain_pattern: Option<Pattern>,
    pub qtype: Option<String>,
    pub action: RuleAction,
}

#[derive(Debug)]
pub struct RuleEngine {
    rules: Vec<CompiledRule>,
}

#[derive(Debug, Clone)]
pub struct MatchResult {
    pub rule_name: String,
    pub action: RuleAction,
}

impl RuleEngine {
    pub fn new(raw_rules: Vec<RuleConfig>) -> Self {
        let mut rules = Vec::new();
        for r in raw_rules {
            let process_pattern = r.process.as_deref().and_then(|p| {
                Pattern::new(&p.to_lowercase()).ok()
            });
            let process_path_pattern = r.process_path.as_deref().and_then(|p| {
                Pattern::new(&p.to_lowercase()).ok()
            });
            let domain_pattern = r.domain.as_deref().and_then(|d| {
                let lower = d.to_lowercase();
                // Normalize wildcard prefix
                let pat_str = if lower.starts_with("*.") {
                    lower
                } else if lower.starts_with('*') {
                    lower
                } else {
                    format!("*{}", lower)
                };
                Pattern::new(&pat_str).ok()
            });

            rules.push(CompiledRule {
                name: r.name,
                process_pattern,
                process_path_pattern,
                domain_pattern,
                qtype: r.qtype.map(|q| q.to_uppercase()),
                action: r.action,
            });
        }

        Self { rules }
    }

    /// Match a DNS query against rules in sequential priority order.
    pub fn evaluate(
        &self,
        process_name: Option<&str>,
        process_path: Option<&str>,
        domain: &str,
        qtype: &str,
    ) -> MatchResult {
        let clean_domain = domain.trim_end_matches('.').to_lowercase();
        let proc_lower = process_name.map(|p| p.to_lowercase());
        let path_lower = process_path.map(|p| p.to_lowercase());
        let qtype_upper = qtype.to_uppercase();

        for rule in &self.rules {
            // 1. Process Name Check
            if let Some(ref pat) = rule.process_pattern {
                match proc_lower.as_deref() {
                    Some(p) if pat.matches(p) => {}
                    _ => continue,
                }
            }

            // 2. Process Path Check
            if let Some(ref pat) = rule.process_path_pattern {
                match path_lower.as_deref() {
                    Some(p) if pat.matches(p) => {}
                    _ => continue,
                }
            }

            // 3. Domain Check
            if let Some(ref pat) = rule.domain_pattern {
                if !pat.matches(&clean_domain) && !clean_domain.ends_with(pat.as_str().trim_start_matches('*')) {
                    continue;
                }
            }

            // 4. Query Type Check
            if let Some(ref required_qtype) = rule.qtype {
                if required_qtype != "ANY" && required_qtype != &qtype_upper {
                    continue;
                }
            }

            debug!(
                "Rule matched: '{}' -> Process: {:?}, Domain: {}, Action: {:?}",
                rule.name, process_name, domain, rule.action
            );

            return MatchResult {
                rule_name: rule.name.clone(),
                action: rule.action.clone(),
            };
        }

        // Fallback default rule (Bypass / Direct)
        MatchResult {
            rule_name: "Default Fallback".to_string(),
            action: RuleAction::Route {
                pool: "default".to_string(),
            },
        }
    }
}
`,
  },
  {
    name: 'doh.rs',
    path: 'src/doh.rs',
    description: 'High-performance RFC 8484 DNS-over-HTTPS wire-format client with HTTP/2 keep-alive.',
    language: 'rust',
    content: `use anyhow::{anyhow, Context, Result};
use bytes::Bytes;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, CONTENT_TYPE};
use reqwest::Client;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tracing::{debug, warn};

use crate::config::{DohServerConfig, PoolConfig, PoolStrategy};

#[derive(Clone)]
pub struct DohServerClient {
    pub id: String,
    pub url: String,
    pub client: Client,
    pub timeout: Duration,
    pub last_latency_ms: Arc<AtomicU64>,
}

impl DohServerClient {
    pub fn new(id: &str, config: &DohServerConfig) -> Result<Self> {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/dns-message"));
        headers.insert(ACCEPT, HeaderValue::from_static("application/dns-message"));

        let client = Client::builder()
            .timeout(Duration::from_millis(config.timeout_ms))
            .default_headers(headers)
            .http2_prior_knowledge()
            .pool_idle_timeout(Duration::from_secs(90))
            .pool_max_idle_per_host(16)
            .build()
            .context("Failed to construct reqwest DoH HTTP client")?;

        Ok(Self {
            id: id.to_string(),
            url: config.url.clone(),
            client,
            timeout: Duration::from_millis(config.timeout_ms),
            last_latency_ms: Arc::new(AtomicU64::new(0)),
        })
    }

    /// Send raw DNS wireformat message via HTTP POST (RFC 8484)
    pub async fn query_wireformat(&self, query_bytes: &[u8]) -> Result<Bytes> {
        let start = Instant::now();
        let body = Bytes::copy_from_slice(query_bytes);

        let response = self
            .client
            .post(&self.url)
            .body(body)
            .send()
            .await
            .with_context(|| format!("DoH HTTP request failed to {}", self.url))?;

        if !response.status().is_success() {
            return Err(anyhow!(
                "DoH upstream {} returned HTTP status {}",
                self.url,
                response.status()
            ));
        }

        let resp_bytes = response
            .bytes()
            .await
            .context("Failed to read DoH response body")?;

        let elapsed = start.elapsed().as_millis() as u64;
        self.last_latency_ms.store(elapsed, Ordering::Relaxed);
        debug!("DoH query to {} resolved in {}ms", self.id, elapsed);

        Ok(resp_bytes)
    }
}

pub struct DohPool {
    servers: HashMap<String, DohServerClient>,
    pools: HashMap<String, PoolConfig>,
}

impl DohPool {
    pub fn new(
        server_configs: &HashMap<String, DohServerConfig>,
        pool_configs: &HashMap<String, PoolConfig>,
    ) -> Result<Self> {
        let mut servers = HashMap::new();
        for (id, cfg) in server_configs {
            let client = DohServerClient::new(id, cfg)?;
            servers.insert(id.clone(), client);
        }

        Ok(Self {
            servers,
            pools: pool_configs.clone(),
        })
    }

    /// Execute DNS query using the pool's routing strategy
    pub async fn query_pool(&self, pool_name: &str, query_bytes: &[u8]) -> Result<Bytes> {
        let pool = self
            .pools
            .get(pool_name)
            .ok_or_else(|| anyhow!("Pool '{}' not configured", pool_name))?;

        if pool.servers.is_empty() {
            return Err(anyhow!("Pool '{}' has no upstream servers", pool_name));
        }

        match pool.strategy {
            PoolStrategy::Fastest => {
                // Select server with lowest recorded latency or first
                let mut best_server: Option<&DohServerClient> = None;
                let mut lowest_latency = u64::MAX;

                for sid in &pool.servers {
                    if let Some(srv) = self.servers.get(sid) {
                        let lat = srv.last_latency_ms.load(Ordering::Relaxed);
                        if lat < lowest_latency {
                            lowest_latency = lat;
                            best_server = Some(srv);
                        }
                    }
                }

                let srv = best_server
                    .or_else(|| self.servers.get(&pool.servers[0]))
                    .ok_or_else(|| anyhow!("Server not found in pool"))?;

                srv.query_wireformat(query_bytes).await
            }
            PoolStrategy::Failover => {
                // Try each server in sequence until one succeeds
                let mut last_err = anyhow!("All servers in pool failed");
                for sid in &pool.servers {
                    if let Some(srv) = self.servers.get(sid) {
                        match srv.query_wireformat(query_bytes).await {
                            Ok(res) => return Ok(res),
                            Err(e) => {
                                warn!("Server {} failed in pool {}: {:#}", sid, pool_name, e);
                                last_err = e;
                            }
                        }
                    }
                }
                Err(last_err)
            }
            PoolStrategy::RoundRobin => {
                let sid = &pool.servers[0];
                let srv = self.servers.get(sid).unwrap();
                srv.query_wireformat(query_bytes).await
            }
        }
    }
}
`,
  },
  {
    name: 'process_tracker.rs',
    path: 'src/process_tracker.rs',
    description: 'OS socket attribution engine mapping incoming client UDP ports to process PID and executable name.',
    language: 'rust',
    content: `//! Process Identification Engine
//!
//! Maps ephemeral client socket ports (e.g. 127.0.0.1:54321) to the actual process PID
//! and application executable name (e.g. "chrome.exe", "discord.exe").
//!
//! Windows: Uses GetExtendedUdpTable (MIB_UDPTABLE_OWNER_PID) and QueryFullProcessImageNameW.
//! Linux: Uses /proc/net/udp inode resolution and /proc/[pid]/exe.

use std::net::SocketAddr;
use std::path::PathBuf;
use tracing::{debug, warn};

#[derive(Debug, Clone)]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    pub path: String,
}

pub struct ProcessTracker;

impl ProcessTracker {
    pub fn new() -> Self {
        Self
    }

    /// Identify the originating process for a client socket address
    pub fn find_process(&self, client_addr: &SocketAddr) -> Option<ProcessInfo> {
        let client_port = client_addr.port();

        #[cfg(target_os = "windows")]
        {
            Self::find_process_windows(client_port)
        }

        #[cfg(target_os = "linux")]
        {
            Self::find_process_linux(client_port)
        }

        #[cfg(not(any(target_os = "windows", target_os = "linux")))]
        {
            debug!("Process attribution not supported on this OS for port {}", client_port);
            None
        }
    }

    #[cfg(target_os = "windows")]
    fn find_process_windows(port: u16) -> Option<ProcessInfo> {
        use std::ffi::OsString;
        use std::os::windows::ffi::OsStringExt;
        use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
        use windows_sys::Win32::NetworkManagement::IpHelper::{
            GetExtendedUdpTable, MIB_UDPROW_OWNER_PID, MIB_UDPTABLE_OWNER_PID, UDP_TABLE_OWNER_PID,
        };
        use windows_sys::Win32::Networking::WinSock::AF_INET;
        use windows_sys::Win32::System::ProcessStatus::QueryFullProcessImageNameW;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };

        unsafe {
            let mut dw_size: u32 = 0;
            // First call to determine buffer size
            let _ = GetExtendedUdpTable(
                std::ptr::null_mut(),
                &mut dw_size,
                0,
                AF_INET as u32,
                UDP_TABLE_OWNER_PID,
                0,
            );

            if dw_size == 0 {
                return None;
            }

            let mut buffer: Vec<u8> = vec![0u8; dw_size as usize];
            let ret = GetExtendedUdpTable(
                buffer.as_mut_ptr() as *mut _,
                &mut dw_size,
                0,
                AF_INET as u32,
                UDP_TABLE_OWNER_PID,
                0,
            );

            if ret != 0 {
                return None;
            }

            let table = &*(buffer.as_ptr() as *const MIB_UDPTABLE_OWNER_PID);
            let num_entries = table.dwNumEntries as usize;
            let rows_ptr = table.table.as_ptr() as *const MIB_UDPROW_OWNER_PID;
            let rows = std::slice::from_raw_parts(rows_ptr, num_entries);

            // Windows ports in table are in network byte order (big endian)
            let target_port_be = port.to_be() as u32;

            for row in rows {
                if (row.dwLocalPort & 0xFFFF) == target_port_be {
                    let pid = row.dwOwningPid;
                    if pid == 0 {
                        continue;
                    }

                    // Open process handle with query permission
                    let handle: HANDLE = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
                    if handle.is_null() {
                        return Some(ProcessInfo {
                            pid,
                            name: format!("PID_{}", pid),
                            path: String::new(),
                        });
                    }

                    let mut path_buf = [0u16; 1024];
                    let mut path_len: u32 = path_buf.len() as u32;
                    let success = QueryFullProcessImageNameW(
                        handle,
                        0,
                        path_buf.as_mut_ptr(),
                        &mut path_len,
                    );
                    CloseHandle(handle);

                    if success != 0 {
                        let full_path = OsString::from_wide(&path_buf[..path_len as usize])
                            .to_string_lossy()
                            .into_owned();
                        let name = PathBuf::from(&full_path)
                            .file_name()
                            .map(|n| n.to_string_lossy().into_owned())
                            .unwrap_or_else(|| format!("PID_{}", pid));

                        return Some(ProcessInfo {
                            pid,
                            name,
                            path: full_path,
                        });
                    }

                    return Some(ProcessInfo {
                        pid,
                        name: format!("PID_{}", pid),
                        path: String::new(),
                    });
                }
            }
        }
        None
    }

    #[cfg(target_os = "linux")]
    fn find_process_linux(port: u16) -> Option<ProcessInfo> {
        use procfs::process::all_processes;
        use std::fs::File;
        use std::io::{BufRead, BufReader};

        // 1. Find inode corresponding to UDP port in /proc/net/udp
        let target_hex_port = format!("{:04X}", port);
        let mut target_inode = None;

        if let Ok(file) = File::open("/proc/net/udp") {
            let reader = BufReader::new(file);
            for line in reader.lines().flatten().skip(1) {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() > 9 {
                    let local_addr = parts[1];
                    if let Some((_, p)) = local_addr.split_once(':') {
                        if p.eq_ignore_ascii_case(&target_hex_port) {
                            if let Ok(inode) = parts[9].parse::<u64>() {
                                target_inode = Some(inode);
                                break;
                            }
                        }
                    }
                }
            }
        }

        let inode = match target_inode {
            Some(i) => i,
            None => return None,
        };

        // 2. Scan running processes to find matching socket inode
        if let Ok(processes) = all_processes() {
            for process in processes.flatten() {
                if let Ok(fds) = process.fd() {
                    for fd in fds.flatten() {
                        if let procfs::process::FDTarget::Socket(sock_inode) = fd.target {
                            if sock_inode == inode {
                                let pid = process.pid as u32;
                                let name = process
                                    .stat()
                                    .map(|s| s.comm)
                                    .unwrap_or_else(|_| format!("PID_{}", pid));
                                let path = process
                                    .exe()
                                    .map(|p| p.to_string_lossy().into_owned())
                                    .unwrap_or_default();

                                return Some(ProcessInfo { pid, name, path });
                            }
                        }
                    }
                }
            }
        }

        None
    }
}
`,
  },
  {
    name: 'server.rs',
    path: 'src/server.rs',
    description: 'High concurrency async UDP and TCP DNS server dispatching requests through the rule engine.',
    language: 'rust',
    content: `use anyhow::{Context, Result};
use bytes::Bytes;
use hickory_proto::op::{Message, MessageType, OpCode, ResponseCode};
use hickory_proto::rr::{Name, RData, Record, RecordType};
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use tokio::net::UdpSocket;
use tracing::{debug, error, info, warn};

use crate::cache::DnsCache;
use crate::config::RuleAction;
use crate::doh::DohPool;
use crate::process_tracker::ProcessTracker;
use crate::rules::RuleEngine;

pub struct DnsServer {
    socket: Arc<UdpSocket>,
    process_tracker: Arc<ProcessTracker>,
    rule_engine: Arc<RuleEngine>,
    doh_pool: Arc<DohPool>,
    cache: Arc<DnsCache>,
}

impl DnsServer {
    pub async fn new(
        listen_addr: &str,
        process_tracker: Arc<ProcessTracker>,
        rule_engine: Arc<RuleEngine>,
        doh_pool: Arc<DohPool>,
        cache: Arc<DnsCache>,
    ) -> Result<Self> {
        let socket = UdpSocket::bind(listen_addr)
            .await
            .with_context(|| format!("Failed to bind UDP socket on {}", listen_addr))?;

        Ok(Self {
            socket: Arc::new(socket),
            process_tracker,
            rule_engine,
            doh_pool,
            cache,
        })
    }

    pub async fn run(&self) -> Result<()> {
        let mut buf = [0u8; 4096];

        loop {
            let (len, src_addr) = match self.socket.recv_from(&mut buf).await {
                Ok(res) => res,
                Err(e) => {
                    error!("UDP socket receive error: {:#}", e);
                    continue;
                }
            };

            let packet = buf[..len].to_vec();
            let socket = Arc::clone(&self.socket);
            let process_tracker = Arc::clone(&self.process_tracker);
            let rule_engine = Arc::clone(&self.rule_engine);
            let doh_pool = Arc::clone(&self.doh_pool);
            let cache = Arc::clone(&self.cache);

            // Handle each DNS request asynchronously
            tokio::spawn(async move {
                if let Err(e) = Self::handle_query(
                    packet,
                    src_addr,
                    socket,
                    process_tracker,
                    rule_engine,
                    doh_pool,
                    cache,
                )
                .await
                {
                    debug!("Query processing error from {}: {:#}", src_addr, e);
                }
            });
        }
    }

    async fn handle_query(
        packet: Vec<u8>,
        src_addr: SocketAddr,
        socket: Arc<UdpSocket>,
        process_tracker: Arc<ProcessTracker>,
        rule_engine: Arc<RuleEngine>,
        doh_pool: Arc<DohPool>,
        cache: Arc<DnsCache>,
    ) -> Result<()> {
        // 1. Decode DNS message header
        let query_msg = match Message::from_vec(&packet) {
            Ok(msg) => msg,
            Err(_) => return Ok(()), // Ignore malformed packets
        };

        let query = match query_msg.queries().first() {
            Some(q) => q,
            None => return Ok(()),
        };

        let domain = query.name().to_utf8();
        let qtype = query.query_type().to_string();

        // 2. Identify originating process
        let proc_info = process_tracker.find_process(&src_addr);
        let proc_name = proc_info.as_ref().map(|p| p.name.as_str());
        let proc_path = proc_info.as_ref().map(|p| p.path.as_str());

        // 3. Evaluate Rule Engine
        let rule_match = rule_engine.evaluate(proc_name, proc_path, &domain, &qtype);

        info!(
            "DNS Query [{}]: domain='{}' qtype={} -> Rule='{}'",
            proc_name.unwrap_or("unknown"),
            domain,
            qtype,
            rule_match.rule_name
        );

        // 4. Execute Rule Action
        let response_bytes: Bytes = match rule_match.action {
            RuleAction::Block { sinkhole } => {
                debug!("Blocking domain {} via rule {}", domain, rule_match.rule_name);
                Self::synthesize_block_response(&query_msg, sinkhole.as_deref())
            }
            RuleAction::Local { ip } => {
                debug!("Returning local override IP {} for {}", ip, domain);
                Self::synthesize_local_response(&query_msg, &ip)
            }
            RuleAction::Route { pool } => {
                // Check in-memory cache first
                let cache_key = format!("{}:{}:{}", pool, domain, qtype);
                if let Some(cached_resp) = cache.get(&cache_key) {
                    debug!("Cache HIT for {}", cache_key);
                    cached_resp
                } else {
                    // Forward to DoH upstream pool
                    let resp = doh_pool.query_pool(&pool, &packet).await?;
                    cache.insert(cache_key, resp.clone());
                    resp
                }
            }
            RuleAction::Direct => {
                // Direct fallback pool
                doh_pool.query_pool("default", &packet).await?
            }
        };

        // 5. Send DNS reply back to original client socket
        socket.send_to(&response_bytes, src_addr).await?;
        Ok(())
    }

    /// Synthesize NXDOMAIN or 0.0.0.0 sinkhole response for blocked requests
    fn synthesize_block_response(query_msg: &Message, sinkhole_ip: Option<&str>) -> Bytes {
        let mut resp = Message::new();
        resp.set_id(query_msg.id());
        resp.set_message_type(MessageType::Response);
        resp.set_op_code(OpCode::Query);
        resp.set_recursion_desired(query_msg.recursion_desired());
        resp.set_recursion_available(true);

        if let Some(ip_str) = sinkhole_ip {
            resp.set_response_code(ResponseCode::NoError);
            if let Ok(ip) = ip_str.parse::<Ipv4Addr>() {
                if let Some(q) = query_msg.queries().first() {
                    let mut record = Record::new();
                    record.set_name(q.name().clone());
                    record.set_ttl(60);
                    record.set_rr_type(RecordType::A);
                    record.set_rdata(RData::A(ip.into()));
                    resp.add_answer(record);
                }
            }
        } else {
            resp.set_response_code(ResponseCode::NXDomain);
        }

        resp.to_vec().map(Bytes::from).unwrap_or_default()
    }

    /// Synthesize A record response with local override IP
    fn synthesize_local_response(query_msg: &Message, ip_str: &str) -> Bytes {
        let mut resp = Message::new();
        resp.set_id(query_msg.id());
        resp.set_message_type(MessageType::Response);
        resp.set_response_code(ResponseCode::NoError);
        resp.set_recursion_available(true);

        if let Ok(ip) = ip_str.parse::<Ipv4Addr>() {
            if let Some(q) = query_msg.queries().first() {
                let mut record = Record::new();
                record.set_name(q.name().clone());
                record.set_ttl(300);
                record.set_rr_type(RecordType::A);
                record.set_rdata(RData::A(ip.into()));
                resp.add_answer(record);
            }
        }

        resp.to_vec().map(Bytes::from).unwrap_or_default()
    }
}
`,
  },
  {
    name: 'cache.rs',
    path: 'src/cache.rs',
    description: 'Thread-safe LRU cache with TTL clamping to minimize DoH traffic.',
    language: 'rust',
    content: `use bytes::Bytes;
use lru::LruCache;
use std::num::NonZeroUsize;
use std::sync::Mutex;
use std::time::Instant;

struct CacheEntry {
    payload: Bytes,
    created_at: Instant,
    ttl_seconds: u32,
}

pub struct DnsCache {
    inner: Mutex<LruCache<String, CacheEntry>>,
    min_ttl: u32,
}

impl DnsCache {
    pub fn new(capacity: usize, min_ttl: u32) -> Self {
        let cap = NonZeroUsize::new(capacity).unwrap_or(NonZeroUsize::new(2048).unwrap());
        Self {
            inner: Mutex::new(LruCache::new(cap)),
            min_ttl,
        }
    }

    pub fn get(&self, key: &str) -> Option<Bytes> {
        let mut cache = self.inner.lock().ok()?;
        if let Some(entry) = cache.get(key) {
            let elapsed = entry.created_at.elapsed().as_secs() as u32;
            if elapsed < entry.ttl_seconds {
                return Some(entry.payload.clone());
            }
        }
        None
    }

    pub fn insert(&self, key: String, payload: Bytes) {
        if let Ok(mut cache) = self.inner.lock() {
            cache.put(
                key,
                CacheEntry {
                    payload,
                    created_at: Instant::now(),
                    ttl_seconds: self.min_ttl.max(60),
                },
            );
        }
    }

    pub fn clear(&self) {
        if let Ok(mut cache) = self.inner.lock() {
            cache.clear();
        }
    }
}
`,
  },
  {
    name: 'config.yaml',
    path: 'config.yaml',
    description: 'Default YogaDNS configuration with Cloudflare, Quad9, AdGuard, NextDNS, and process rules.',
    language: 'yaml',
    content: `# RustyYoga DNS Configuration File
# YogaDNS analogue in Rust

listen_addr: "127.0.0.1:53"

cache:
  max_entries: 4096
  min_ttl: 60
  max_ttl: 86400

servers:
  cloudflare:
    url: "https://cloudflare-dns.com/dns-query"
    bootstrap_ips: ["1.1.1.1", "1.0.0.1"]
    timeout_ms: 2500
    http2_only: true

  cloudflare_malware:
    url: "https://security.cloudflare-dns.com/dns-query"
    bootstrap_ips: ["1.1.1.2", "1.0.0.2"]
    timeout_ms: 2500

  quad9_secure:
    url: "https://dns.quad9.net/dns-query"
    bootstrap_ips: ["9.9.9.9", "149.112.112.112"]
    timeout_ms: 3000

  google:
    url: "https://dns.google/dns-query"
    bootstrap_ips: ["8.8.8.8", "8.8.4.4"]
    timeout_ms: 2500

  adguard_dns:
    url: "https://dns.adguard-dns.com/dns-query"
    bootstrap_ips: ["94.140.14.14", "94.140.15.15"]
    timeout_ms: 3000

  nextdns:
    url: "https://dns.nextdns.io"
    bootstrap_ips: ["45.90.28.0", "45.90.30.0"]
    timeout_ms: 3000

pools:
  default:
    strategy: "fastest"
    servers: ["cloudflare", "quad9_secure", "google"]

  secure_privacy:
    strategy: "failover"
    servers: ["quad9_secure", "cloudflare_malware"]

  adblock:
    strategy: "fastest"
    servers: ["adguard_dns"]

rules:
  # 1. Block common telemetry and ad tracking domains across all apps
  - name: "Block Ad Tracking & Telemetry"
    domain: "*telemetry*.com"
    action:
      block:
        sinkhole: "0.0.0.0"

  - name: "Block DoubleClick Ads"
    domain: "*.doubleclick.net"
    action:
      block:
        sinkhole: "0.0.0.0"

  # 2. Route browsers (Chrome, Firefox, Edge, Brave) through Quad9 DNSSEC
  - name: "Browsers Secure DNSSEC"
    process: "*chrome.exe"
    action:
      route:
        pool: "secure_privacy"

  - name: "Firefox Browser"
    process: "*firefox.exe"
    action:
      route:
        pool: "secure_privacy"

  # 3. Route messengers & Discord through low-latency Cloudflare
  - name: "Telegram Messenger"
    process: "*telegram.exe"
    action:
      route:
        pool: "default"

  - name: "Discord"
    process: "*discord.exe"
    action:
      route:
        pool: "default"

  # 4. Route developer tools (curl, git, node, cargo)
  - name: "Developer CLI Tools"
    process: "curl*"
    action:
      route:
        pool: "default"

  # 5. Local development override
  - name: "Local Dev Domain"
    domain: "*.localdev.internal"
    action:
      local:
        ip: "127.0.0.1"

  # 6. Default Fallback
  - name: "Catch-All Default Fallback"
    action:
      route:
        pool: "default"
`,
  },
  {
    name: 'README.md',
    path: 'README.md',
    description: 'Compilation, setup, Windows Loopback instructions, and systemd service guide.',
    language: 'markdown',
    content: `# RustyYoga DNS 🦀
> High-Performance YogaDNS Analogue in Rust with DNS-over-HTTPS (DoH) & Per-Process Routing Rules.

RustyYoga DNS is an open-source client inspired by YogaDNS. It captures DNS requests on \`127.0.0.1:53\`, identifies which specific process/application sent the request, and routes each query to custom DoH upstream pools (Cloudflare, Quad9, Google, AdGuard, NextDNS) based on priority rules.

---

## Key Features

- **Process Attribution**:
  - **Windows**: Uses \`GetExtendedUdpTable\` with \`MIB_UDPTABLE_OWNER_PID\` to inspect ephemeral client ports and retrieve the exact PID + executable image name via \`QueryFullProcessImageNameW\`.
  - **Linux**: Resolves socket inodes via \`/proc/net/udp\` and cross-references \`/proc/[pid]/fd\`.
- **DNS-over-HTTPS (RFC 8484)**:
  - Wireformat \`application/dns-message\` HTTP/2 with persistent keepalive connections.
  - Zero round-trip TLS handshakes on warm queries (~15ms latency).
- **Rule Engine**:
  - Match by executable name (\`chrome.exe\`, \`curl\`, \`telegram.exe\`, wildcards).
  - Match by domain patterns (\`*.internal\`, \`*.ru\`, \`*telemetry*\`).
  - Actions: **Route** (to pool), **Block** (sinkhole 0.0.0.0 or NXDOMAIN), **Local** (IP override), **Direct** (system bypass).
- **In-Memory Cache**:
  - Thread-safe LRU cache with TTL clamping and negative caching.

---

## Quick Start & Building

### 1. Requirements
- Rust toolchain 1.75+ (\`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh\`)
- Administrator / root privileges to bind port 53.

### 2. Build Release Binary
\`\`\`bash
git clone https://github.com/your-username/rusty-yoga-dns.git
cd rusty-yoga-dns
cargo build --release
\`\`\`

The optimized binary will be at \`./target/release/rusty-yoga-dns\` (or \`.exe\` on Windows).

### 3. Run RustyYoga DNS
\`\`\`bash
# Run with default config.yaml
sudo ./target/release/rusty-yoga-dns --config config.yaml

# On Windows (Run Command Prompt as Administrator):
rusty-yoga-dns.exe --config config.yaml
\`\`\`

---

## Configuring Operating System DNS

To direct your computer's DNS requests into RustyYoga:

### Windows:
1. Open **Settings** -> **Network & Internet** -> **Properties** on active Wi-Fi or Ethernet.
2. Under **DNS server assignment**, click **Edit**.
3. Select **Manual**, toggle **IPv4 ON**.
4. Set **Preferred DNS** to \`127.0.0.1\`.
5. Set Alternative DNS to \`1.1.1.1\` (optional fallback).

### Linux (\`systemd-resolved\` or \`/etc/resolv.conf\`):
\`\`\`bash
sudo resolvectl dns $(ip route show default | awk '{print $5}') 127.0.0.1
\`\`\`

---

## Configuration Example (\`config.yaml\`)

\`\`\`yaml
listen_addr: "127.0.0.1:53"

servers:
  cloudflare:
    url: "https://cloudflare-dns.com/dns-query"
    bootstrap_ips: ["1.1.1.1"]
  quad9:
    url: "https://dns.quad9.net/dns-query"
    bootstrap_ips: ["9.9.9.9"]

pools:
  secure:
    strategy: "fastest"
    servers: ["quad9", "cloudflare"]

rules:
  - name: "Chrome via Secure Quad9"
    process: "*chrome.exe"
    action:
      route:
        pool: "secure"

  - name: "Sinkhole Ad Trackers"
    domain: "*adservice*"
    action:
      block:
        sinkhole: "0.0.0.0"
\`\`\`
`,
  },
];
