//! Process attribution for queries made through the Windows "DNS Client" service (Dnscache).
//!
//! Most programs resolve names via DnsQueryEx/getaddrinfo, so the query reaching DanceDNS comes
//! from svchost.exe. The Microsoft-Windows-DNS-Client ETW provider logs every such call
//! (event 3006) with the PID of the program that made it; we keep a short-lived
//! name → PID map and use it to attribute the svchost query to the real program.

use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use windows_sys::core::GUID;
use windows_sys::Win32::System::Diagnostics::Etw::*;

/// Microsoft-Windows-DNS-Client {1C95126E-7EEA-49A9-A3FE-A378B03DDB4D}
const DNS_CLIENT: GUID = GUID::from_u128(0x1C95126E_7EEA_49A9_A3FE_A378B03DDB4D);
const SESSION: &str = "DanceDNS-DnsClient";
const KEEP: Duration = Duration::from_secs(10);

struct Seen {
    pid: u32,
    at: Instant,
}

fn map() -> &'static Mutex<HashMap<String, Vec<Seen>>> {
    static M: OnceLock<Mutex<HashMap<String, Vec<Seen>>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

/// PIDs (newest first) of programs that recently asked the DNS Client service for `name`.
pub fn lookup(name: &str) -> Vec<u32> {
    let key = name.trim_end_matches('.').to_ascii_lowercase();
    let m = map().lock();
    m.get(&key)
        .map(|v| v.iter().rev().filter(|s| s.at.elapsed() < KEEP).map(|s| s.pid).collect())
        .unwrap_or_default()
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

#[repr(C)]
struct Props {
    p: EVENT_TRACE_PROPERTIES,
    name: [u16; 64],
}

fn props() -> Box<Props> {
    let mut b: Box<Props> = Box::new(unsafe { std::mem::zeroed() });
    b.p.Wnode.BufferSize = std::mem::size_of::<Props>() as u32;
    b.p.Wnode.Flags = WNODE_FLAG_TRACED_GUID;
    b.p.Wnode.ClientContext = 1; // QPC timestamps
    b.p.LogFileMode = EVENT_TRACE_REAL_TIME_MODE;
    b.p.FlushTimer = 1;
    b.p.LoggerNameOffset = std::mem::size_of::<EVENT_TRACE_PROPERTIES>() as u32;
    b
}

unsafe extern "system" fn on_event(rec: *mut EVENT_RECORD) {
    let rec = &*rec;
    // 3006: "DNS query is called for the name %1, type %2 ..." — logged in the caller's process.
    if rec.EventHeader.EventDescriptor.Id != 3006 || rec.UserData.is_null() {
        return;
    }
    let pid = rec.EventHeader.ProcessId;
    if pid == 0 || pid == std::process::id() {
        return;
    }
    let len = rec.UserDataLength as usize / 2;
    let data = std::slice::from_raw_parts(rec.UserData as *const u16, len);
    let end = data.iter().position(|&c| c == 0).unwrap_or(len);
    let name = String::from_utf16_lossy(&data[..end]).trim_end_matches('.').to_ascii_lowercase();
    if name.is_empty() {
        return;
    }
    let mut m = map().lock();
    if m.len() > 20_000 {
        m.retain(|_, v| v.last().map(|s| s.at.elapsed() < KEEP).unwrap_or(false));
    }
    let v = m.entry(name).or_default();
    v.retain(|s| s.pid != pid && s.at.elapsed() < KEEP);
    v.push(Seen { pid, at: Instant::now() });
    if v.len() > 6 {
        v.remove(0);
    }
}

/// Start the ETW session on a background thread. Errors are logged; DanceDNS keeps working
/// without attribution.
pub fn start() {
    std::thread::Builder::new()
        .name("etw-dns".into())
        .spawn(|| {
            if let Err(e) = unsafe { run() } {
                tracing::warn!("ETW (определение программ за службой DNS-клиент) недоступно: {e}");
            }
        })
        .ok();
}

pub fn stop() {
    unsafe {
        let mut p = props();
        let name = wide(SESSION);
        ControlTraceW(CONTROLTRACE_HANDLE { Value: 0 }, name.as_ptr(), &mut p.p, EVENT_TRACE_CONTROL_STOP);
    }
}

unsafe fn run() -> Result<(), String> {
    let name = wide(SESSION);
    let mut handle = CONTROLTRACE_HANDLE { Value: 0 };
    let mut p = props();
    let mut r = StartTraceW(&mut handle, name.as_ptr(), &mut p.p);
    if r == 183 {
        // ERROR_ALREADY_EXISTS: left over from a previous run
        stop();
        p = props();
        r = StartTraceW(&mut handle, name.as_ptr(), &mut p.p);
    }
    if r != 0 {
        return Err(format!("StartTrace: код {r}"));
    }
    let r = EnableTraceEx2(handle, &DNS_CLIENT, EVENT_CONTROL_CODE_ENABLE_PROVIDER, 4, 0, 0, 0, std::ptr::null());
    if r != 0 {
        stop();
        return Err(format!("EnableTraceEx2: код {r}"));
    }
    let mut logger = wide(SESSION);
    let mut lf: EVENT_TRACE_LOGFILEW = std::mem::zeroed();
    lf.LoggerName = logger.as_mut_ptr();
    lf.Anonymous1.ProcessTraceMode = PROCESS_TRACE_MODE_REAL_TIME | PROCESS_TRACE_MODE_EVENT_RECORD;
    lf.Anonymous2.EventRecordCallback = Some(on_event);
    let th = OpenTraceW(&mut lf);
    if th.Value == u64::MAX {
        stop();
        return Err("OpenTrace не удался".into());
    }
    tracing::info!("ETW: определение программ за службой DNS-клиент включено");
    let r = ProcessTrace(&th, 1, std::ptr::null(), std::ptr::null());
    CloseTrace(th);
    if r != 0 {
        return Err(format!("ProcessTrace: код {r}"));
    }
    Ok(())
}
