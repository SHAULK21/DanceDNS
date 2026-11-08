//! Configuration model. The same structure is stored as YAML next to the executable
//! (portable mode) and exchanged as JSON with the web UI.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::net::SocketAddr;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    /// Local DNS listen addresses (UDP + TCP).
    pub listen: Vec<String>,
    /// Web control panel address.
    pub ui_addr: String,
    /// Open the control panel in the default browser on start.
    pub open_browser: bool,
    /// Plain DNS server used by the `direct` action (ip:port).
    pub direct_dns: String,
    /// Pool used when no rule matches.
    pub default_pool: String,
    /// Put the system DNS back to its previous value when DanceDNS exits.
    pub restore_dns_on_exit: bool,
    pub cache: CacheConfig,
    pub servers: Vec<ServerConfig>,
    pub pools: Vec<PoolConfig>,
    pub rules: Vec<RuleConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct CacheConfig {
    pub enabled: bool,
    pub max_entries: usize,
    pub min_ttl: u32,
    pub max_ttl: u32,
}

impl Default for CacheConfig {
    fn default() -> Self {
        Self { enabled: true, max_entries: 4096, min_ttl: 30, max_ttl: 86400 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// RFC 8484 DoH endpoint, e.g. https://cloudflare-dns.com/dns-query
    pub url: String,
    /// IPs used to reach the DoH host without asking the system resolver
    /// (avoids a loop once the system DNS points to DanceDNS).
    #[serde(default)]
    pub bootstrap: Vec<String>,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
}

fn default_timeout_ms() -> u64 {
    3000
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PoolStrategy {
    Fastest,
    RoundRobin,
    Failover,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoolConfig {
    pub id: String,
    pub servers: Vec<String>,
    #[serde(default = "default_strategy")]
    pub strategy: PoolStrategy,
}

fn default_strategy() -> PoolStrategy {
    PoolStrategy::Fastest
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ActionKind {
    /// Resolve through a DoH pool.
    Route,
    /// Answer with NXDOMAIN, or with a sinkhole address.
    Block,
    /// Forward as plain DNS to `direct_dns`.
    Direct,
    /// Answer with a fixed address.
    Local,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuleConfig {
    pub name: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    /// Executable name patterns, comma separated (`chrome.exe, *fox*`). Empty = any.
    #[serde(default)]
    pub process: String,
    /// Executable path patterns, comma separated (`C:\Games\*`). Empty = any.
    #[serde(default)]
    pub process_path: String,
    /// Domain patterns, comma separated. `example.com` also matches subdomains. Empty = any.
    #[serde(default)]
    pub domain: String,
    /// Query types, comma separated (`A, AAAA`). Empty or ANY = any.
    #[serde(default)]
    pub qtype: String,
    pub action: ActionKind,
    #[serde(default)]
    pub pool: String,
    /// For `block`: empty = NXDOMAIN, otherwise sinkhole address (e.g. 0.0.0.0).
    #[serde(default)]
    pub sinkhole: String,
    /// For `local`: address to answer with.
    #[serde(default)]
    pub ip: String,
    #[serde(default)]
    pub description: String,
}

fn yes() -> bool {
    true
}

impl Default for Config {
    fn default() -> Self {
        let srv = |id: &str, name: &str, url: &str, bootstrap: &[&str]| ServerConfig {
            id: id.into(),
            name: name.into(),
            url: url.into(),
            bootstrap: bootstrap.iter().map(|s| s.to_string()).collect(),
            timeout_ms: 3000,
        };
        let rule = |name: &str, process: &str, domain: &str, action: ActionKind, pool: &str, sinkhole: &str, ip: &str, enabled: bool, description: &str| RuleConfig {
            name: name.into(),
            enabled,
            process: process.into(),
            process_path: String::new(),
            domain: domain.into(),
            qtype: String::new(),
            action,
            pool: pool.into(),
            sinkhole: sinkhole.into(),
            ip: ip.into(),
            description: description.into(),
        };
        Config {
            listen: vec!["127.0.0.1:53".into(), "[::1]:53".into()],
            ui_addr: "127.0.0.1:5380".into(),
            open_browser: true,
            direct_dns: "1.1.1.1:53".into(),
            default_pool: "default".into(),
            restore_dns_on_exit: true,
            cache: CacheConfig::default(),
            servers: vec![
                srv("cloudflare", "Cloudflare", "https://cloudflare-dns.com/dns-query", &["1.1.1.1", "1.0.0.1", "2606:4700:4700::1111"]),
                srv("cloudflare-security", "Cloudflare Security", "https://security.cloudflare-dns.com/dns-query", &["1.1.1.2", "1.0.0.2"]),
                srv("quad9", "Quad9", "https://dns.quad9.net/dns-query", &["9.9.9.9", "149.112.112.112"]),
                srv("google", "Google Public DNS", "https://dns.google/dns-query", &["8.8.8.8", "8.8.4.4"]),
                srv("adguard", "AdGuard DNS", "https://dns.adguard-dns.com/dns-query", &["94.140.14.14", "94.140.15.15"]),
                srv("mullvad", "Mullvad DNS", "https://dns.mullvad.net/dns-query", &["194.242.2.2"]),
                srv("controld", "Control D (unfiltered)", "https://freedns.controld.com/p0", &["76.76.2.0", "76.76.10.0"]),
            ],
            pools: vec![
                PoolConfig { id: "default".into(), servers: vec!["cloudflare".into(), "quad9".into(), "google".into()], strategy: PoolStrategy::Fastest },
                PoolConfig { id: "secure".into(), servers: vec!["quad9".into(), "cloudflare-security".into()], strategy: PoolStrategy::Failover },
                PoolConfig { id: "adblock".into(), servers: vec!["adguard".into(), "mullvad".into()], strategy: PoolStrategy::Fastest },
            ],
            rules: vec![
                rule("Блокировать DoubleClick", "", "doubleclick.net", ActionKind::Block, "", "0.0.0.0", "", true, "Рекламная сеть Google — отвечать 0.0.0.0"),
                rule("Браузеры через Quad9", "chrome.exe, firefox.exe, msedge.exe, brave.exe", "", ActionKind::Route, "secure", "", "", true, "Браузеры резолвят через пул secure"),
                rule("Локальная разработка", "", "localdev.internal", ActionKind::Local, "", "", "127.0.0.1", true, "*.localdev.internal → 127.0.0.1"),
                rule("Игры — без рекламы", "", "", ActionKind::Route, "adblock", "", "", false, "Пример: укажите exe игры и включите правило"),
            ],
        }
    }
}

impl Config {
    pub fn load_or_create(path: &Path) -> Result<Self> {
        if !path.exists() {
            let cfg = Config::default();
            cfg.save(path).context("не удалось создать файл конфигурации")?;
            return Ok(cfg);
        }
        let content = std::fs::read_to_string(path)
            .with_context(|| format!("не удалось прочитать {}", path.display()))?;
        let cfg: Config = serde_yaml::from_str(&content)
            .with_context(|| format!("ошибка в {}", path.display()))?;
        cfg.validate()?;
        Ok(cfg)
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        let yaml = serde_yaml::to_string(self)?;
        let header = "# DanceDNS configuration. Edit here or in the web panel (http://127.0.0.1:5380).\n";
        let tmp = path.with_extension("yaml.tmp");
        std::fs::write(&tmp, format!("{header}{yaml}"))?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }

    pub fn validate(&self) -> Result<()> {
        if self.listen.is_empty() {
            bail!("нужен хотя бы один адрес в listen");
        }
        for l in &self.listen {
            l.parse::<SocketAddr>().with_context(|| format!("неверный адрес listen: {l}"))?;
        }
        self.ui_addr.parse::<SocketAddr>().with_context(|| format!("неверный ui_addr: {}", self.ui_addr))?;
        self.direct_dns.parse::<SocketAddr>().with_context(|| format!("неверный direct_dns: {}", self.direct_dns))?;

        let mut server_ids = HashSet::new();
        for s in &self.servers {
            if s.id.trim().is_empty() {
                bail!("у сервера пустой id");
            }
            if !server_ids.insert(s.id.as_str()) {
                bail!("повторяющийся id сервера: {}", s.id);
            }
            let u = url::Url::parse(&s.url).with_context(|| format!("неверный URL сервера {}: {}", s.id, s.url))?;
            if u.scheme() != "https" {
                bail!("сервер {}: DoH URL должен начинаться с https://", s.id);
            }
            for ip in &s.bootstrap {
                ip.parse::<std::net::IpAddr>()
                    .with_context(|| format!("сервер {}: неверный bootstrap IP {ip}", s.id))?;
            }
        }
        let mut pool_ids = HashSet::new();
        for p in &self.pools {
            if !pool_ids.insert(p.id.as_str()) {
                bail!("повторяющийся id пула: {}", p.id);
            }
            if p.servers.is_empty() {
                bail!("пул {} пустой", p.id);
            }
            for s in &p.servers {
                if !server_ids.contains(s.as_str()) {
                    bail!("пул {} ссылается на неизвестный сервер {}", p.id, s);
                }
            }
        }
        if !pool_ids.contains(self.default_pool.as_str()) {
            bail!("пул по умолчанию '{}' не существует", self.default_pool);
        }
        for r in &self.rules {
            match r.action {
                ActionKind::Route => {
                    if !pool_ids.contains(r.pool.as_str()) {
                        bail!("правило '{}' ссылается на неизвестный пул '{}'", r.name, r.pool);
                    }
                }
                ActionKind::Block => {
                    if !r.sinkhole.trim().is_empty() {
                        r.sinkhole.trim().parse::<std::net::IpAddr>()
                            .with_context(|| format!("правило '{}': неверный sinkhole адрес", r.name))?;
                    }
                }
                ActionKind::Local => {
                    r.ip.trim().parse::<std::net::IpAddr>()
                        .with_context(|| format!("правило '{}': неверный IP", r.name))?;
                }
                ActionKind::Direct => {}
            }
        }
        Ok(())
    }
}
