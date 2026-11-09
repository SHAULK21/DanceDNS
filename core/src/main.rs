//! DanceDNS — portable process-aware DNS client (DNS-over-QUIC / DNS-over-HTTPS) for Windows.
//!
//! Double-click the exe: a small window and a tray icon appear, the local DNS server starts on
//! 127.0.0.1:53 / [::1]:53 and Windows is pointed at it. Settings live in `dancedns.yaml`
//! next to the executable.

#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]
#![cfg_attr(not(windows), allow(dead_code, unused_imports))]

mod app;
mod cache;
mod config;
mod dnsmsg;
mod doq;
mod engine;
#[cfg(windows)]
mod etw;
#[cfg(windows)]
mod intercept;
#[cfg(windows)]
mod gui;
#[cfg_attr(not(windows), allow(dead_code))]
mod packet;
mod process;
mod rules;
mod server;
mod sysdns;
mod upstream;

use anyhow::{Context, Result};
use clap::Parser;
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(name = "dancedns", version, about = "Portable process-aware DNS-over-QUIC/HTTPS client")]
struct Args {
    /// Config file (default: dancedns.yaml next to the executable)
    #[arg(short, long)]
    config: Option<PathBuf>,
    /// Override DNS listen addresses (comma separated), e.g. 127.0.0.1:5353
    #[arg(short, long)]
    listen: Option<String>,
    /// Run without a window (log to stdout), stop with Ctrl+C
    #[arg(long)]
    headless: bool,
    /// Restore the system DNS settings saved by a previous run and exit
    #[arg(long)]
    restore_dns: bool,
    /// Debug logging (every query)
    #[arg(short, long)]
    verbose: bool,
}

fn portable_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

fn main() {
    let args = Args::parse();
    if let Err(e) = run(args) {
        let msg = format!("{e:#}");
        tracing::error!("{msg}");
        fatal(&msg);
    }
}

#[cfg(windows)]
fn fatal(msg: &str) {
    gui::error_box("DanceDNS", msg);
    std::process::exit(1);
}

#[cfg(not(windows))]
fn fatal(msg: &str) {
    eprintln!("Ошибка: {msg}");
    std::process::exit(1);
}

fn init_logging(data_dir: &std::path::Path, verbose: bool, headless: bool) {
    let filter = if verbose { "dancedns=debug,info" } else { "dancedns=info,warn" };
    let filter = tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| filter.into());
    let builder = tracing_subscriber::fmt().with_env_filter(filter).with_target(false);
    if headless || cfg!(not(windows)) {
        builder.init();
    } else {
        // no console in the GUI build: keep a small log file next to the exe
        let path = data_dir.join("dancedns.log");
        if std::fs::metadata(&path).map(|m| m.len() > 2_000_000).unwrap_or(false) {
            let _ = std::fs::rename(&path, data_dir.join("dancedns.old.log"));
        }
        match std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            Ok(f) => builder.with_ansi(false).with_writer(std::sync::Mutex::new(f)).init(),
            Err(_) => builder.init(),
        }
    }
}

fn run(args: Args) -> Result<()> {
    let config_path = args.config.clone().unwrap_or_else(|| portable_dir().join("dancedns.yaml"));
    let data_dir = config_path
        .parent()
        .map(|p| p.to_path_buf())
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| PathBuf::from("."));
    init_logging(&data_dir, args.verbose, args.headless);

    if args.restore_dns {
        sysdns::disable(&data_dir)?;
        tracing::info!("Системный DNS восстановлен.");
        return Ok(());
    }

    #[cfg(windows)]
    if !gui::single_instance() {
        gui::error_box("DanceDNS", "DanceDNS уже запущен — ищите значок в области уведомлений (трее).");
        return Ok(());
    }

    let mut config = config::Config::load_or_create(&config_path)?;
    if let Some(l) = &args.listen {
        config.listen = l.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    }
    config.validate()?;
    tracing::info!("DanceDNS {} запущен, настройки: {}", env!("CARGO_PKG_VERSION"), config_path.display());

    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().worker_threads(4).build()?;
    let listen = config.listen.clone();
    let auto_enable = config.auto_enable;
    let engine = engine::Engine::new(config, config_path.clone())?;
    let listeners = rt.block_on(server::start(engine.clone(), &listen));
    let app = app::App::new(engine, listeners, data_dir, rt.handle().clone());
    app.start_background();

    #[cfg(windows)]
    if !args.headless {
        gui::run(app.clone(), auto_enable).context("ошибка интерфейса")?;
        app.shutdown();
        rt.shutdown_timeout(std::time::Duration::from_secs(1));
        return Ok(());
    }

    // headless
    if auto_enable && cfg!(windows) {
        if let Err(e) = app.enable() {
            tracing::error!("{e:#}");
        }
    }
    rt.block_on(exit_signal());
    app.shutdown();
    Ok(())
}

#[cfg(windows)]
async fn exit_signal() {
    use tokio::signal::windows;
    let mut c = windows::ctrl_c().expect("ctrl_c");
    let mut close = windows::ctrl_close().expect("ctrl_close");
    tokio::select! {
        _ = c.recv() => {}
        _ = close.recv() => {}
    }
}

#[cfg(not(windows))]
async fn exit_signal() {
    use tokio::signal::unix::{signal, SignalKind};
    let mut term = signal(SignalKind::terminate()).expect("sigterm");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = term.recv() => {}
    }
}
