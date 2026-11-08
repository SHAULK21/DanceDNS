//! Local web control panel: REST API + embedded single-page UI.

use crate::config::Config;
use crate::dnsmsg;
use crate::engine::{Engine, Origin};
use crate::process::{ProcessInfo, ProcessTracker, Proto};
use crate::server::ListenerState;
use crate::sysdns;
use axum::body::Body;
use axum::extract::{Query, Request, State};
use axum::http::{header, HeaderValue, Method, StatusCode, Uri};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use rust_embed::RustEmbed;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Notify;

#[derive(RustEmbed)]
#[folder = "../dist"]
struct Assets;

#[derive(Clone)]
pub struct AppState {
    pub engine: Arc<Engine>,
    pub listeners: ListenerState,
    pub data_dir: PathBuf,
    pub shutdown: Arc<Notify>,
    pub listen_at_start: Vec<String>,
}

type ApiResult = Result<Json<Value>, (StatusCode, Json<Value>)>;

fn err(code: StatusCode, e: impl std::fmt::Display) -> (StatusCode, Json<Value>) {
    (code, Json(json!({ "error": e.to_string() })))
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/status", get(status))
        .route("/api/config", get(get_config).put(put_config))
        .route("/api/config/default", get(default_config))
        .route("/api/logs", get(logs))
        .route("/api/logs/clear", post(clear_logs))
        .route("/api/cache/clear", post(clear_cache))
        .route("/api/resolve", post(resolve))
        .route("/api/benchmark", post(benchmark))
        .route("/api/system-dns", get(sysdns_status).post(sysdns_set))
        .route("/api/shutdown", post(shutdown))
        .fallback(static_handler)
        .layer(middleware::from_fn(guard))
        .with_state(state)
}

/// Only accept requests addressed to localhost (blocks DNS-rebinding) and require a JSON
/// content type on state-changing requests (forces a CORS preflight for cross-site pages).
async fn guard(req: Request, next: Next) -> Response {
    let host = req.headers().get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or("");
    let hostname = if host.starts_with('[') { host.split(']').next().map(|h| format!("{h}]")).unwrap_or_default() } else { host.split(':').next().unwrap_or("").to_string() };
    if !matches!(hostname.as_str(), "127.0.0.1" | "localhost" | "[::1]") {
        return (StatusCode::FORBIDDEN, "forbidden host").into_response();
    }
    if req.method() != Method::GET && req.method() != Method::HEAD {
        let ct = req.headers().get(header::CONTENT_TYPE).and_then(|h| h.to_str().ok()).unwrap_or("");
        if !ct.starts_with("application/json") {
            return (StatusCode::UNSUPPORTED_MEDIA_TYPE, "application/json required").into_response();
        }
    }
    let mut res = next.run(req).await;
    res.headers_mut().insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    res
}

async fn static_handler(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    let (file, name) = match Assets::get(path) {
        Some(f) => (f, path),
        None => match Assets::get("index.html") {
            Some(f) => (f, "index.html"),
            None => {
                return (
                    StatusCode::OK,
                    [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
                    "<h1>DanceDNS</h1><p>Интерфейс не встроен в эту сборку: выполните <code>npm run build</code> перед <code>cargo build</code>. API работает на /api/status.</p>",
                )
                    .into_response()
            }
        },
    };
    let mime = mime_guess::from_path(name).first_or_octet_stream();
    let cache = if name == "index.html" { "no-cache" } else { "public, max-age=31536000, immutable" };
    Response::builder()
        .header(header::CONTENT_TYPE, mime.as_ref())
        .header(header::CACHE_CONTROL, cache)
        .body(Body::from(file.data.into_owned()))
        .unwrap()
}

pub fn is_admin() -> Option<bool> {
    #[cfg(windows)]
    unsafe {
        return Some(windows_sys::Win32::UI::Shell::IsUserAnAdmin() != 0);
    }
    #[cfg(target_os = "linux")]
    {
        let s = std::fs::read_to_string("/proc/self/status").ok()?;
        let uid = s.lines().find(|l| l.starts_with("Uid:"))?.split_whitespace().nth(2)?.to_string();
        return Some(uid == "0");
    }
    #[allow(unreachable_code)]
    None
}

async fn status(State(s): State<AppState>) -> ApiResult {
    let rt = s.engine.rt();
    let restart_required = rt.config.listen != s.listen_at_start;
    Ok(Json(json!({
        "version": env!("CARGO_PKG_VERSION"),
        "os": std::env::consts::OS,
        "admin": is_admin(),
        "uptime_s": s.engine.started.elapsed().as_secs(),
        "listeners": *s.listeners.lock(),
        "counters": s.engine.counters(),
        "cache_entries": rt.cache.len(),
        "upstreams": rt.upstreams.servers.iter().map(|u| u.stats()).collect::<Vec<_>>(),
        "process_attribution": ProcessTracker::supported(),
        "config_path": s.engine.config_path.display().to_string(),
        "system_dns_active": sysdns::is_active(&s.data_dir),
        "restart_required": restart_required,
    })))
}

async fn get_config(State(s): State<AppState>) -> ApiResult {
    Ok(Json(serde_json::to_value(&s.engine.rt().config).unwrap()))
}

async fn default_config() -> ApiResult {
    Ok(Json(serde_json::to_value(Config::default()).unwrap()))
}

async fn put_config(State(s): State<AppState>, Json(cfg): Json<Config>) -> ApiResult {
    let restart_required = cfg.listen != s.listen_at_start || cfg.ui_addr != s.engine.rt().config.ui_addr;
    s.engine.apply_config(cfg).map_err(|e| err(StatusCode::BAD_REQUEST, format!("{e:#}")))?;
    Ok(Json(json!({ "ok": true, "restart_required": restart_required })))
}

#[derive(Deserialize)]
struct LogQuery {
    #[serde(default)]
    after: u64,
    #[serde(default = "default_limit")]
    limit: usize,
}
fn default_limit() -> usize {
    500
}

async fn logs(State(s): State<AppState>, Query(q): Query<LogQuery>) -> ApiResult {
    Ok(Json(json!({ "entries": s.engine.logs_after(q.after, q.limit.min(3000)) })))
}

async fn clear_logs(State(s): State<AppState>) -> ApiResult {
    s.engine.clear_logs();
    Ok(Json(json!({ "ok": true })))
}

async fn clear_cache(State(s): State<AppState>) -> ApiResult {
    s.engine.rt().cache.clear();
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct ResolveReq {
    domain: String,
    #[serde(default = "a")]
    qtype: String,
    #[serde(default)]
    process: String,
    #[serde(default)]
    process_path: String,
}
fn a() -> String {
    "A".into()
}

async fn resolve(State(s): State<AppState>, Json(r): Json<ResolveReq>) -> ApiResult {
    let packet = dnsmsg::build_query(&r.domain, &r.qtype).map_err(|e| err(StatusCode::BAD_REQUEST, format!("неверный запрос: {e}")))?;
    let forced = if r.process.trim().is_empty() && r.process_path.trim().is_empty() {
        Some(ProcessInfo { pid: 0, name: "(тест)".into(), path: String::new() })
    } else {
        let name = if r.process.trim().is_empty() {
            r.process_path.rsplit(['\\', '/']).next().unwrap_or("").to_string()
        } else {
            r.process.trim().to_string()
        };
        Some(ProcessInfo { pid: 0, name, path: r.process_path.trim().to_string() })
    };
    let origin = Origin { client: "127.0.0.1:0".parse().unwrap(), proto: Proto::Tcp, server_port: 0, forced_process: forced, transport_label: "test" };
    let (_, entry) = s.engine.handle(&packet, origin).await;
    Ok(Json(serde_json::to_value(entry).unwrap()))
}

async fn benchmark(State(s): State<AppState>) -> ApiResult {
    let rt = s.engine.rt();
    let packet = dnsmsg::build_query("example.com.", "A").unwrap();
    let mut tasks = Vec::new();
    for u in rt.upstreams.servers.iter().cloned() {
        let p = packet.clone();
        tasks.push(tokio::spawn(async move {
            let mut times = Vec::new();
            let mut error = None;
            for _ in 0..3 {
                let t = std::time::Instant::now();
                match u.query(&p).await {
                    Ok(_) => times.push(t.elapsed().as_secs_f64() * 1000.0),
                    Err(e) => {
                        error = Some(format!("{e:#}"));
                        break;
                    }
                }
            }
            let best = times.iter().cloned().fold(f64::INFINITY, f64::min);
            json!({
                "id": u.id,
                "ok": error.is_none(),
                "latency_ms": if times.is_empty() { Value::Null } else { json!(best) },
                "first_ms": times.first(),
                "error": error,
            })
        }));
    }
    let mut out = Vec::new();
    for t in tasks {
        if let Ok(v) = t.await {
            out.push(v);
        }
    }
    Ok(Json(json!({ "results": out })))
}

async fn sysdns_status(State(s): State<AppState>) -> ApiResult {
    let dir = s.data_dir.clone();
    let st = tokio::task::spawn_blocking(move || sysdns::status(&dir)).await.map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(serde_json::to_value(st).unwrap()))
}

#[derive(Deserialize)]
struct SysDnsReq {
    enable: bool,
}

async fn sysdns_set(State(s): State<AppState>, Json(r): Json<SysDnsReq>) -> ApiResult {
    let dir = s.data_dir.clone();
    if r.enable {
        let ok = s.listeners.lock().iter().any(|l| l.udp && l.addr.starts_with("127.0.0.1"));
        if !ok {
            return Err(err(StatusCode::CONFLICT, "DNS-сервер на 127.0.0.1:53 не запущен — нельзя переключать систему на него (запустите DanceDNS от имени администратора и убедитесь, что порт 53 свободен)"));
        }
    }
    let with_v6 = s.listeners.lock().iter().any(|l| l.udp && l.addr.starts_with("[::1]"));
    let res = tokio::task::spawn_blocking(move || if r.enable { sysdns::enable(&dir, with_v6) } else { sysdns::disable(&dir) })
        .await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    res.map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
    sysdns_status(State(s)).await
}

async fn shutdown(State(s): State<AppState>) -> ApiResult {
    s.shutdown.notify_one();
    Ok(Json(json!({ "ok": true })))
}
