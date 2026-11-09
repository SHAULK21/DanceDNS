//! Maps the client socket of a DNS query (source port on loopback) to the process that owns it.
//!
//! Windows: GetExtendedUdpTable / GetExtendedTcpTable (owner PID) + QueryFullProcessImageNameW.
//! Linux:   /proc/net/{udp,udp6,tcp,tcp6} socket inode → /proc/<pid>/fd.

use parking_lot::Mutex;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Default)]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    pub path: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Proto {
    Udp,
    Tcp,
}

pub struct ProcessTracker {
    by_pid: Mutex<HashMap<u32, (ProcessInfo, Instant)>>,
}

impl ProcessTracker {
    pub fn new() -> Self {
        Self { by_pid: Mutex::new(HashMap::new()) }
    }

    pub fn find(&self, client: &SocketAddr, proto: Proto, server_port: u16) -> Option<ProcessInfo> {
        let pid = owner_pid(client, proto, server_port)?;
        Some(self.describe(pid))
    }

    /// Name and path of a PID (cached for a few seconds).
    pub fn describe(&self, pid: u32) -> ProcessInfo {
        {
            let cache = self.by_pid.lock();
            if let Some((info, t)) = cache.get(&pid) {
                if t.elapsed() < Duration::from_secs(20) {
                    return info.clone();
                }
            }
        }
        let info = describe_pid(pid);
        let mut cache = self.by_pid.lock();
        if cache.len() > 4096 {
            cache.clear();
        }
        cache.insert(pid, (info.clone(), Instant::now()));
        info
    }
}

// ---------------------------------------------------------------- Windows
#[cfg(windows)]
fn owner_pid(client: &SocketAddr, proto: Proto, server_port: u16) -> Option<u32> {
    use windows_sys::Win32::NetworkManagement::IpHelper::*;
    use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_INET6};

    let port = client.port();
    let v6 = client.is_ipv6();
    let family = if v6 { AF_INET6 } else { AF_INET } as u32;

    unsafe fn fetch(f: impl Fn(*mut core::ffi::c_void, *mut u32) -> u32) -> Option<Vec<u64>> {
        let mut size: u32 = 0;
        f(std::ptr::null_mut(), &mut size);
        for _ in 0..4 {
            if size == 0 {
                return None;
            }
            // u64 buffer → 8-byte alignment for the table structs
            let mut buf = vec![0u64; (size as usize + 7) / 8 + 1];
            let ret = f(buf.as_mut_ptr() as *mut _, &mut size);
            if ret == 0 {
                return Some(buf);
            }
            if ret != 122 {
                return None; // not ERROR_INSUFFICIENT_BUFFER
            }
        }
        None
    }
    let p = |raw: u32| u16::from_be((raw & 0xffff) as u16);

    unsafe {
        match (proto, v6) {
            (Proto::Udp, false) => {
                let buf = fetch(|b, s| GetExtendedUdpTable(b, s, 0, family, UDP_TABLE_OWNER_PID, 0))?;
                let t = &*(buf.as_ptr() as *const MIB_UDPTABLE_OWNER_PID);
                let rows = std::slice::from_raw_parts(t.table.as_ptr(), t.dwNumEntries as usize);
                rows.iter().find(|r| p(r.dwLocalPort) == port && r.dwOwningPid != 0).map(|r| r.dwOwningPid)
            }
            (Proto::Udp, true) => {
                let buf = fetch(|b, s| GetExtendedUdpTable(b, s, 0, family, UDP_TABLE_OWNER_PID, 0))?;
                let t = &*(buf.as_ptr() as *const MIB_UDP6TABLE_OWNER_PID);
                let rows = std::slice::from_raw_parts(t.table.as_ptr(), t.dwNumEntries as usize);
                rows.iter().find(|r| p(r.dwLocalPort) == port && r.dwOwningPid != 0).map(|r| r.dwOwningPid)
            }
            (Proto::Tcp, false) => {
                let buf = fetch(|b, s| GetExtendedTcpTable(b, s, 0, family, TCP_TABLE_OWNER_PID_CONNECTIONS, 0))?;
                let t = &*(buf.as_ptr() as *const MIB_TCPTABLE_OWNER_PID);
                let rows = std::slice::from_raw_parts(t.table.as_ptr(), t.dwNumEntries as usize);
                rows.iter().find(|r| p(r.dwLocalPort) == port && p(r.dwRemotePort) == server_port && r.dwOwningPid != 0).map(|r| r.dwOwningPid)
            }
            (Proto::Tcp, true) => {
                let buf = fetch(|b, s| GetExtendedTcpTable(b, s, 0, family, TCP_TABLE_OWNER_PID_CONNECTIONS, 0))?;
                let t = &*(buf.as_ptr() as *const MIB_TCP6TABLE_OWNER_PID);
                let rows = std::slice::from_raw_parts(t.table.as_ptr(), t.dwNumEntries as usize);
                rows.iter().find(|r| p(r.dwLocalPort) == port && p(r.dwRemotePort) == server_port && r.dwOwningPid != 0).map(|r| r.dwOwningPid)
            }
        }
    }
}

#[cfg(windows)]
fn describe_pid(pid: u32) -> ProcessInfo {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION};

    if pid == 4 {
        return ProcessInfo { pid, name: "System".into(), path: String::new() };
    }
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h == 0 {
            return ProcessInfo { pid, name: format!("PID {pid}"), path: String::new() };
        }
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut len);
        CloseHandle(h);
        if ok == 0 {
            return ProcessInfo { pid, name: format!("PID {pid}"), path: String::new() };
        }
        let path = std::ffi::OsString::from_wide(&buf[..len as usize]).to_string_lossy().into_owned();
        let name = path.rsplit(['\\', '/']).next().unwrap_or(&path).to_string();
        ProcessInfo { pid, name, path }
    }
}

// ---------------------------------------------------------------- Linux
#[cfg(target_os = "linux")]
fn owner_pid(client: &SocketAddr, proto: Proto, server_port: u16) -> Option<u32> {
    let files: &[&str] = match proto {
        Proto::Udp => &["/proc/net/udp", "/proc/net/udp6"],
        Proto::Tcp => &["/proc/net/tcp", "/proc/net/tcp6"],
    };
    let port_hex = format!("{:04X}", client.port());
    let server_hex = format!("{:04X}", server_port);
    let mut inode = None;
    'outer: for f in files {
        let Ok(text) = std::fs::read_to_string(f) else { continue };
        for line in text.lines().skip(1) {
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.len() < 10 {
                continue;
            }
            let local_port = cols[1].rsplit(':').next().unwrap_or("");
            let remote_port = cols[2].rsplit(':').next().unwrap_or("");
            if local_port.eq_ignore_ascii_case(&port_hex) && (proto == Proto::Udp || remote_port.eq_ignore_ascii_case(&server_hex)) {
                if let Ok(i) = cols[9].parse::<u64>() {
                    if i != 0 {
                        inode = Some(i);
                        break 'outer;
                    }
                }
            }
        }
    }
    let target = format!("socket:[{}]", inode?);
    for entry in std::fs::read_dir("/proc").ok()?.flatten() {
        let Some(pid) = entry.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else { continue };
        let Ok(fds) = std::fs::read_dir(entry.path().join("fd")) else { continue };
        for fd in fds.flatten() {
            if let Ok(link) = std::fs::read_link(fd.path()) {
                if link.as_os_str() == target.as_str() {
                    return Some(pid);
                }
            }
        }
    }
    None
}

#[cfg(target_os = "linux")]
fn describe_pid(pid: u32) -> ProcessInfo {
    let path = std::fs::read_link(format!("/proc/{pid}/exe")).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    let name = if !path.is_empty() {
        path.rsplit('/').next().unwrap_or(&path).to_string()
    } else {
        std::fs::read_to_string(format!("/proc/{pid}/comm")).map(|s| s.trim().to_string()).unwrap_or_else(|_| format!("PID {pid}"))
    };
    ProcessInfo { pid, name, path }
}

// ---------------------------------------------------------------- other
#[cfg(not(any(windows, target_os = "linux")))]
fn owner_pid(_client: &SocketAddr, _proto: Proto, _server_port: u16) -> Option<u32> {
    None
}

#[cfg(not(any(windows, target_os = "linux")))]
fn describe_pid(pid: u32) -> ProcessInfo {
    ProcessInfo { pid, name: format!("PID {pid}"), path: String::new() }
}
