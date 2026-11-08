//! DanceDNS — portable process-aware DNS-over-HTTPS client.
//!
//! Run the executable: it creates `dancedns.yaml` next to itself, starts a local DNS server
//! on 127.0.0.1:53 / [::1]:53 and opens the control panel at http://127.0.0.1:5380.

mod api;
mod cache;
mod config;
mod dnsmsg;
mod engine;
mod process;
mod rules;
mod server;
mod sysdns;
mod upstream;

use anyhow::{Context, Result};
use clap::Parser;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Notify;

#[derive(Parser, Debug)]
#[command(name = "dancedns", version, about = "Portable process-aware DNS-over-HTTPS client")]
struct Args {
    /// Config file (default: dancedns.yaml next to the executable)
    #[arg(short, long)]
    config: Option<PathBuf>,
    /// Override DNS listen addresses (comma separated), e.g. 127.0.0.1:5353
    #[arg(short, long)]
    listen: Option<String>,
    /// Override control panel address, e.g. 127.0.0.1:5380
    #[arg(long)]
    ui: Option<String>,
    /// Do not open the browser
    #[arg(long)]
    no_browser: bool,
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

#[tokio::main]
async fn main() {
    if let Err(e) = run().await {
        eprintln!("\nОшибка: {e:#}");
        #[cfg(windows)]
        {
            eprintln!("\nНажмите Enter, чтобы закрыть окно...");
            let _ = std::io::stdin().read_line(&mut String::new());
        }
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let args = Args::parse();
    let filter = if args.verbose { "dancedns=debug,info" } else { "dancedns=info,warn" };
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| filter.into()))
        .with_target(false)
        .init();

    let config_path = args.config.clone().unwrap_or_else(|| portable_dir().join("dancedns.yaml"));
    let data_dir = config_path.parent().map(|p| p.to_path_buf()).filter(|p| !p.as_os_str().is_empty()).unwrap_or_else(|| PathBuf::from("."));

    if args.restore_dns {
        sysdns::disable(&data_dir)?;
        println!("Системный DNS восстановлен.");
        return Ok(());
    }

    let mut config = config::Config::load_or_create(&config_path)?;
    if let Some(l) = &args.listen {
        config.listen = l.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    }
    if let Some(u) = &args.ui {
        config.ui_addr = u.clone();
    }
    config.validate()?;

    println!("DanceDNS {} — портативный DoH-клиент с правилами по процессам", env!("CARGO_PKG_VERSION"));
    println!("Конфигурация: {}", config_path.display());
    if api::is_admin() == Some(false) {
        tracing::warn!("Запущено без прав администратора: порт 53 и смена системного DNS могут быть недоступны.");
    }

    let listen = config.listen.clone();
    let ui_addr = config.ui_addr.clone();
    let open_browser = config.open_browser && !args.no_browser;
    let restore_on_exit = config.restore_dns_on_exit;

    let engine = engine::Engine::new(config, config_path.clone())?;
    let listeners = server::start(engine.clone(), &listen).await;

    let shutdown = Arc::new(Notify::new());
    let state = api::AppState {
        engine: engine.clone(),
        listeners,
        data_dir: data_dir.clone(),
        shutdown: shutdown.clone(),
        listen_at_start: listen,
    };
    let app = api::router(state);
    let listener = tokio::net::TcpListener::bind(&ui_addr)
        .await
        .with_context(|| format!("не удалось открыть панель управления на {ui_addr} (DanceDNS уже запущен?)"))?;
    let url = format!("http://{}", ui_addr.replace("0.0.0.0", "127.0.0.1"));
    println!("Панель управления: {url}");
    println!("Закройте это окно или нажмите Ctrl+C, чтобы остановить DanceDNS.\n");
    if open_browser {
        let _ = open::that_detached(&url);
    }

    let server = axum::serve(listener, app);
    tokio::select! {
        r = server => { r?; }
        _ = shutdown.notified() => { tracing::info!("Остановка по запросу из панели"); }
        _ = exit_signal() => { tracing::info!("Остановка..."); }
    }

    if restore_on_exit && sysdns::is_active(&data_dir) {
        match tokio::task::spawn_blocking(move || sysdns::disable(&data_dir)).await {
            Ok(Ok(())) => println!("Системный DNS восстановлен."),
            Ok(Err(e)) => eprintln!("Не удалось восстановить системный DNS: {e:#}. Запустите `dancedns --restore-dns`."),
            Err(e) => eprintln!("{e}"),
        }
    }
    Ok(())
}

#[cfg(windows)]
async fn exit_signal() {
    use tokio::signal::windows;
    let mut c = windows::ctrl_c().expect("ctrl_c");
    let mut close = windows::ctrl_close().expect("ctrl_close");
    let mut logoff = windows::ctrl_logoff().expect("ctrl_logoff");
    let mut shut = windows::ctrl_shutdown().expect("ctrl_shutdown");
    tokio::select! {
        _ = c.recv() => {}
        _ = close.recv() => {}
        _ = logoff.recv() => {}
        _ = shut.recv() => {}
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
