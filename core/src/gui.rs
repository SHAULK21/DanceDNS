//! Minimal native Windows interface: one small window + tray icon. No console, no browser.

use crate::app::App;
use crate::engine::LogEntry;
use native_windows_gui as nwg;
use parking_lot::Mutex;
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

const MAX_ROWS: usize = 200;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

pub fn error_box(title: &str, text: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
    let (t, m) = (wide(title), wide(text));
    unsafe {
        MessageBoxW(0, m.as_ptr(), t.as_ptr(), MB_OK | MB_ICONERROR);
    }
}

/// Returns false if another DanceDNS is already running.
pub fn single_instance() -> bool {
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
    use windows_sys::Win32::System::Threading::CreateMutexW;
    let name = wide("Global\\DanceDNS-single-instance");
    unsafe {
        let h = CreateMutexW(std::ptr::null(), 0, name.as_ptr());
        // the handle is intentionally leaked: it lives as long as the process
        !(h == 0 || GetLastError() == ERROR_ALREADY_EXISTS)
    }
}

/// Result of a background enable/disable operation.
enum Job {
    Running,
    Done(Result<(), String>),
}

#[derive(Default)]
struct Ui {
    window: nwg::Window,
    icon: nwg::Icon,
    font_big: nwg::Font,
    status: nwg::Label,
    detail: nwg::Label,
    toggle: nwg::Button,
    settings: nwg::Button,
    pool_label: nwg::Label,
    pools: nwg::ComboBox<String>,
    stats: nwg::Label,
    log: nwg::ListView,
    timer: nwg::AnimationTimer,
    tray: nwg::TrayNotification,
    menu: nwg::Menu,
    m_open: nwg::MenuItem,
    m_toggle: nwg::MenuItem,
    m_sep: nwg::MenuSeparator,
    m_exit: nwg::MenuItem,
}

pub fn run(app: Arc<App>, auto_enable: bool) -> anyhow::Result<()> {
    nwg::init().map_err(|e| anyhow::anyhow!("{e}"))?;
    let _ = nwg::Font::set_global_family("Segoe UI");

    let mut ui = Ui::default();
    let embed = nwg::EmbedResource::load(None).map_err(|e| anyhow::anyhow!("{e}"))?;
    let _ = nwg::Icon::builder().source_embed(Some(&embed)).source_embed_id(1).size(Some((32, 32))).build(&mut ui.icon);

    let start_hidden = app.config().start_minimized;
    let mut flags = nwg::WindowFlags::WINDOW | nwg::WindowFlags::MINIMIZE_BOX;
    if !start_hidden {
        flags |= nwg::WindowFlags::VISIBLE;
    }
    nwg::Window::builder()
        .size((480, 520))
        .center(true)
        .title("DanceDNS")
        .icon(Some(&ui.icon))
        .flags(flags)
        .build(&mut ui.window)?;

    nwg::Font::builder().family("Segoe UI").size(26).weight(700).build(&mut ui.font_big)?;
    nwg::Label::builder().background_color(Some([255, 255, 255])).parent(&ui.window).position((16, 12)).size((448, 32)).font(Some(&ui.font_big)).text("Запуск…").build(&mut ui.status)?;
    nwg::Label::builder().background_color(Some([255, 255, 255])).parent(&ui.window).position((16, 46)).size((448, 36)).text("").build(&mut ui.detail)?;
    nwg::Button::builder().parent(&ui.window).position((16, 88)).size((180, 34)).text("Включить защиту").build(&mut ui.toggle)?;
    nwg::Button::builder().parent(&ui.window).position((204, 88)).size((130, 34)).text("Настройки…").build(&mut ui.settings)?;
    nwg::Label::builder().background_color(Some([255, 255, 255])).parent(&ui.window).position((16, 138)).size((70, 22)).text("Серверы:").build(&mut ui.pool_label)?;
    nwg::ComboBox::builder().parent(&ui.window).position((88, 134)).size((376, 200)).collection(Vec::new()).build(&mut ui.pools)?;
    nwg::Label::builder().background_color(Some([255, 255, 255])).parent(&ui.window).position((16, 170)).size((448, 22)).text("").build(&mut ui.stats)?;
    nwg::ListView::builder()
        .parent(&ui.window)
        .position((16, 196))
        .size((448, 286))
        .list_style(nwg::ListViewStyle::Detailed)
        .ex_flags(nwg::ListViewExFlags::FULL_ROW_SELECT)
        .double_buffer(true)
        .build(&mut ui.log)?;
    for (i, (name, w)) in [("Время", 62), ("Программа", 116), ("Домен", 186), ("Итог", 64)].iter().enumerate() {
        ui.log.insert_column(nwg::InsertListViewColumn { index: Some(i as i32), fmt: None, width: Some(*w), text: Some(name.to_string()) });
    }
    ui.log.set_headers_enabled(true);

    nwg::AnimationTimer::builder().parent(&ui.window).interval(Duration::from_millis(800)).build(&mut ui.timer)?;
    nwg::TrayNotification::builder().parent(&ui.window).icon(Some(&ui.icon)).tip(Some("DanceDNS")).build(&mut ui.tray)?;
    nwg::Menu::builder().popup(true).parent(&ui.window).build(&mut ui.menu)?;
    nwg::MenuItem::builder().text("Открыть DanceDNS").parent(&ui.menu).build(&mut ui.m_open)?;
    nwg::MenuItem::builder().text("Включить защиту").parent(&ui.menu).build(&mut ui.m_toggle)?;
    nwg::MenuSeparator::builder().parent(&ui.menu).build(&mut ui.m_sep)?;
    nwg::MenuItem::builder().text("Выход").parent(&ui.menu).build(&mut ui.m_exit)?;

    let ui = Rc::new(ui);
    let job: Arc<Mutex<Option<Job>>> = Arc::new(Mutex::new(None));
    let last_seq = Rc::new(Cell::new(0u64));
    let pool_ids: Rc<RefCell<Vec<String>>> = Rc::new(RefCell::new(Vec::new()));
    let hint_shown = Rc::new(Cell::new(false));
    let banner: Rc<RefCell<Option<String>>> = Rc::new(RefCell::new(None));

    fill_pools(&ui, &app, &pool_ids);

    let start_job = {
        let app = app.clone();
        let job = job.clone();
        move |enable: bool| {
            if matches!(*job.lock(), Some(Job::Running)) {
                return;
            }
            *job.lock() = Some(Job::Running);
            let app = app.clone();
            let job = job.clone();
            std::thread::spawn(move || {
                let r = if enable { app.enable() } else { app.disable() };
                *job.lock() = Some(Job::Done(r.map_err(|e| format!("{e:#}"))));
            });
        }
    };

    if auto_enable && !app.protected() {
        start_job(true);
    }

    let refresh = {
        let ui = ui.clone();
        let app = app.clone();
        let job = job.clone();
        let last_seq = last_seq.clone();
        let pool_ids = pool_ids.clone();
        let banner = banner.clone();
        move || {
            // finished background job?
            let done = {
                let mut j = job.lock();
                match j.take() {
                    Some(Job::Done(r)) => Some(r),
                    other => {
                        *j = other;
                        None
                    }
                }
            };
            if let Some(Err(e)) = done {
                *banner.borrow_mut() = Some(e.clone());
                nwg::modal_error_message(&ui.window, "DanceDNS", &e);
            } else if let Some(Ok(())) = done {
                *banner.borrow_mut() = None;
            }
            if let Some(res) = app.reload_if_changed() {
                match res {
                    Ok(()) => {
                        *banner.borrow_mut() = None;
                        fill_pools(&ui, &app, &pool_ids);
                    }
                    Err(e) => *banner.borrow_mut() = Some(format!("Ошибка в dancedns.yaml: {e:#}")),
                }
            }
            update_status(&ui, &app, matches!(*job.lock(), Some(Job::Running)), banner.borrow().as_deref());
            let fresh = app.engine.logs_after(last_seq.get(), MAX_ROWS);
            if let Some(last) = fresh.last() {
                last_seq.set(last.seq);
                append_rows(&ui.log, &fresh);
            }
        }
    };
    refresh();
    ui.timer.start();

    let handler = {
        let ui_ref = Rc::downgrade(&ui);
        let app = app.clone();
        let pool_ids = pool_ids.clone();
        let refresh = refresh.clone();
        move |evt: nwg::Event, data: nwg::EventData, handle: nwg::ControlHandle| {
            let Some(ui) = ui_ref.upgrade() else { return };
            use nwg::Event as E;
            match evt {
                E::OnTimerTick if handle == ui.timer => refresh(),
                E::OnButtonClick if handle == ui.toggle => start_job(!app.protected()),
                E::OnMenuItemSelected if handle == ui.m_toggle => start_job(!app.protected()),
                E::OnButtonClick if handle == ui.settings => app.open_config_in_editor(),
                E::OnComboxBoxSelection if handle == ui.pools => {
                    if let Some(i) = ui.pools.selection() {
                        if let Some(id) = pool_ids.borrow().get(i) {
                            if let Err(e) = app.set_default_pool(id) {
                                nwg::modal_error_message(&ui.window, "DanceDNS", &format!("{e:#}"));
                            }
                        }
                    }
                }
                E::OnWindowClose if handle == ui.window => {
                    // closing the window keeps DanceDNS running in the tray
                    if let nwg::EventData::OnWindowClose(d) = &data {
                        d.close(false);
                    }
                    ui.window.set_visible(false);
                    if !hint_shown.get() {
                        hint_shown.set(true);
                        ui.tray.show("DanceDNS продолжает работать. Выход — правой кнопкой по значку.", Some("DanceDNS"), None, None);
                    }
                }
                E::OnMousePress(nwg::MousePressEvent::MousePressLeftUp) if handle == ui.tray => {
                    show_window(&ui);
                }
                E::OnContextMenu if handle == ui.tray => {
                    ui.m_toggle.set_checked(app.protected());
                    let (x, y) = nwg::GlobalCursor::position();
                    ui.menu.popup(x, y);
                }
                E::OnMenuItemSelected if handle == ui.m_open => show_window(&ui),
                E::OnMenuItemSelected if handle == ui.m_exit => {
                    ui.tray.set_visibility(false);
                    nwg::stop_thread_dispatch();
                }
                _ => {}
            }
        }
    };
    let eh = nwg::full_bind_event_handler(&ui.window.handle, handler);
    nwg::dispatch_thread_events();
    nwg::unbind_event_handler(&eh);
    Ok(())
}

fn show_window(ui: &Ui) {
    ui.window.set_visible(true);
    ui.window.restore();
    ui.window.set_focus();
}

fn fill_pools(ui: &Ui, app: &App, ids: &RefCell<Vec<String>>) {
    let cfg = app.config();
    let mut labels = Vec::new();
    let mut list = Vec::new();
    for p in &cfg.pools {
        let names: Vec<String> = p
            .servers
            .iter()
            .map(|s| cfg.servers.iter().find(|x| &x.id == s).map(|x| if x.name.is_empty() { x.id.clone() } else { x.name.clone() }).unwrap_or(s.clone()))
            .collect();
        let proto: Vec<&str> = {
            let mut v: Vec<&str> = p
                .servers
                .iter()
                .filter_map(|s| cfg.servers.iter().find(|x| &x.id == s))
                .map(|x| if x.url.starts_with("quic://") { "DoQ" } else { "DoH" })
                .collect();
            v.dedup();
            v
        };
        labels.push(format!("{} ({}) — {}", p.id, proto.join("+"), names.join(", ")));
        list.push(p.id.clone());
    }
    let sel = list.iter().position(|id| id == &cfg.default_pool);
    ui.pools.set_collection(labels);
    ui.pools.set_selection(sel);
    *ids.borrow_mut() = list;
}

fn update_status(ui: &Ui, app: &App, busy: bool, banner: Option<&str>) {
    let protected = app.protected();
    let running = app.dns_running();
    let (title, tip) = if busy {
        ("⏳ Подождите…", "DanceDNS")
    } else if !running {
        ("⚠ DNS-сервер не запущен", "DanceDNS: ошибка")
    } else if protected {
        ("● Защита включена", "DanceDNS: защита включена")
    } else {
        ("○ Защита выключена", "DanceDNS: защита выключена")
    };
    if ui.status.text() != title {
        ui.status.set_text(title);
        ui.tray.set_tip(tip);
    }
    let rt = app.engine.rt();
    let detail = if let Some(b) = banner {
        b.to_string()
    } else if !running {
        app.listener_errors().join("; ")
    } else {
        let pool = &rt.config.default_pool;
        let members: Vec<String> = rt
            .upstreams
            .servers
            .iter()
            .filter(|u| rt.config.pools.iter().any(|p| &p.id == pool && p.servers.contains(&u.id)))
            .map(|u| {
                let s = u.stats();
                let lat = match (s.healthy, s.latency_ms) {
                    (false, _) => "недоступен".to_string(),
                    (true, Some(ms)) => format!("{:.0} мс", ms),
                    (true, None) => "—".into(),
                };
                format!("{} {} ({lat})", s.protocol, s.name)
            })
            .collect();
        if let Some(w) = app.last_error.lock().clone() {
            w
        } else if protected {
            let how = if app.intercepting() { "Весь DNS Windows (включая обход) идёт через DanceDNS" } else { "DNS Windows идёт через DanceDNS" };
            format!("{how}.\n{}", members.join(" · "))
        } else {
            format!("Windows использует обычный DNS. Нажмите «Включить защиту».\n{}", members.join(" · "))
        }
    };
    if ui.detail.text() != detail {
        ui.detail.set_text(&detail);
    }
    let btn = if protected { "Выключить защиту" } else { "Включить защиту" };
    if ui.toggle.text() != btn {
        ui.toggle.set_text(btn);
        ui.m_toggle.set_checked(protected);
    }
    ui.toggle.set_enabled(!busy && (app.can_switch_system() || protected));
    let c = app.engine.counters();
    let stats = format!(
        "Запросов: {}   DoQ/DoH: {}   кэш: {}   заблокировано: {}   ошибок: {}",
        c.total, c.resolved, c.cached, c.blocked, c.errors
    );
    if ui.stats.text() != stats {
        ui.stats.set_text(&stats);
    }
}

fn status_text(e: &LogEntry) -> &'static str {
    match e.status {
        "resolved" if e.transport == "intercept" => "перехват",
        "resolved" => "ok",
        "cached" => "кэш",
        "blocked" => "блок",
        "local" => "свой IP",
        "direct" => "напрямую",
        _ => "ошибка",
    }
}

fn append_rows(lv: &nwg::ListView, entries: &[LogEntry]) {
    lv.set_redraw(false);
    for e in entries {
        let time = {
            let secs = (e.ts / 1000) as i64;
            let local = secs + local_offset_secs();
            let s = local.rem_euclid(86400);
            format!("{:02}:{:02}:{:02}", s / 3600, (s / 60) % 60, s % 60)
        };
        let row = [time, e.process.clone(), e.domain.clone(), status_text(e).to_string()];
        lv.insert_items_row(Some(0), &row);
    }
    while lv.len() > MAX_ROWS {
        lv.remove_item(lv.len() - 1);
    }
    lv.set_redraw(true);
}

fn local_offset_secs() -> i64 {
    use windows_sys::Win32::System::Time::{GetTimeZoneInformation, TIME_ZONE_INFORMATION};
    unsafe {
        let mut tz: TIME_ZONE_INFORMATION = std::mem::zeroed();
        let r = GetTimeZoneInformation(&mut tz);
        let mut bias = tz.Bias;
        if r == 2 {
            bias += tz.DaylightBias;
        } else {
            bias += tz.StandardBias;
        }
        -(bias as i64) * 60
    }
}
