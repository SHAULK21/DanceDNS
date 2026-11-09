//! Application state shared by the window/tray UI and the DNS engine.

use crate::config::Config;
use crate::engine::Engine;
use crate::server::ListenerState;
use crate::sysdns;
use parking_lot::Mutex;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::SystemTime;

pub struct App {
    pub engine: Arc<Engine>,
    pub listeners: ListenerState,
    pub data_dir: PathBuf,
    pub rt: tokio::runtime::Handle,
    config_mtime: Mutex<Option<SystemTime>>,
    pub last_error: Mutex<Option<String>>,
}

impl App {
    pub fn new(engine: Arc<Engine>, listeners: ListenerState, data_dir: PathBuf, rt: tokio::runtime::Handle) -> Arc<Self> {
        let mtime = std::fs::metadata(&engine.config_path).and_then(|m| m.modified()).ok();
        Arc::new(Self { engine, listeners, data_dir, rt, config_mtime: Mutex::new(mtime), last_error: Mutex::new(None) })
    }

    pub fn config(&self) -> Config {
        self.engine.rt().config.clone()
    }

    pub fn dns_running(&self) -> bool {
        self.listeners.lock().iter().any(|l| l.udp && l.addr.starts_with("127.0.0.1:"))
    }

    /// Windows can only use a DNS server on port 53.
    pub fn can_switch_system(&self) -> bool {
        self.listeners.lock().iter().any(|l| l.udp && l.addr == "127.0.0.1:53")
    }

    pub fn listener_errors(&self) -> Vec<String> {
        self.listeners.lock().iter().filter_map(|l| l.error.as_ref().map(|e| format!("{}: {}", l.addr, e))).collect()
    }

    pub fn protected(&self) -> bool {
        sysdns::is_active(&self.data_dir)
    }

    /// Start optional Windows helpers (ETW attribution; interception if protection is already on).
    pub fn start_background(&self) {
        #[cfg(windows)]
        {
            let cfg = self.config();
            if cfg.etw_attribution {
                crate::etw::start();
            }
            if self.protected() && cfg.intercept_all {
                self.start_intercept();
            }
        }
    }

    #[cfg(windows)]
    fn start_intercept(&self) {
        match crate::intercept::start(self.engine.clone(), self.rt.clone(), &self.data_dir) {
            Ok(()) => *self.last_error.lock() = None,
            Err(e) => {
                tracing::error!("{e:#}");
                *self.last_error.lock() = Some(format!("Полный перехват не включён: {e:#}"));
            }
        }
    }

    pub fn intercepting(&self) -> bool {
        #[cfg(windows)]
        return crate::intercept::is_running();
        #[cfg(not(windows))]
        false
    }

    /// Point Windows at DanceDNS and start interception. Blocking (runs PowerShell), call from a worker thread.
    pub fn enable(&self) -> anyhow::Result<()> {
        if !self.can_switch_system() {
            anyhow::bail!(
                "DNS-сервер DanceDNS не запущен на 127.0.0.1:53 (порт занят другой программой?).\n{}",
                self.listener_errors().join("\n")
            );
        }
        let with_v6 = self.listeners.lock().iter().any(|l| l.udp && l.addr.starts_with("[::1]"));
        sysdns::enable(&self.data_dir, with_v6)?;
        #[cfg(windows)]
        if self.config().intercept_all {
            self.start_intercept();
        }
        Ok(())
    }

    pub fn disable(&self) -> anyhow::Result<()> {
        #[cfg(windows)]
        crate::intercept::stop();
        *self.last_error.lock() = None;
        sysdns::disable(&self.data_dir)
    }

    pub fn set_default_pool(&self, pool: &str) -> anyhow::Result<()> {
        let mut cfg = self.config();
        if cfg.default_pool == pool {
            return Ok(());
        }
        cfg.default_pool = pool.to_string();
        self.engine.apply_config(cfg)?;
        self.engine.rt().cache.clear();
        *self.config_mtime.lock() = std::fs::metadata(&self.engine.config_path).and_then(|m| m.modified()).ok();
        Ok(())
    }

    /// Reload dancedns.yaml if it was edited by hand. Returns Some(result) when a reload happened.
    pub fn reload_if_changed(&self) -> Option<anyhow::Result<()>> {
        let now = std::fs::metadata(&self.engine.config_path).and_then(|m| m.modified()).ok();
        {
            let mut last = self.config_mtime.lock();
            if now == *last {
                return None;
            }
            *last = now;
        }
        let res = (|| {
            let text = std::fs::read_to_string(&self.engine.config_path)?;
            let cfg: Config = serde_yaml::from_str(&text)?;
            cfg.validate()?;
            self.engine.apply_runtime(cfg)?;
            self.engine.rt().cache.clear();
            Ok(())
        })();
        if let Err(e) = &res {
            tracing::error!("ошибка в настройках: {e:#}");
        } else {
            tracing::info!("настройки перечитаны");
        }
        Some(res)
    }

    pub fn open_config_in_editor(&self) {
        let path = self.engine.config_path.clone();
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let _ = std::process::Command::new("notepad.exe").arg(&path).creation_flags(0x0800_0000).spawn();
        }
        #[cfg(not(windows))]
        {
            let _ = std::process::Command::new("xdg-open").arg(&path).spawn();
        }
    }

    /// Called once on exit.
    pub fn shutdown(&self) {
        #[cfg(windows)]
        {
            crate::intercept::stop();
            crate::etw::stop();
        }
        if self.config().restore_dns_on_exit && self.protected() {
            if let Err(e) = self.disable() {
                tracing::error!("не удалось вернуть системный DNS: {e:#}");
            }
        }
    }
}
