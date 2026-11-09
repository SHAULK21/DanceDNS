//! Point the operating system's DNS at DanceDNS (and back).
//! Windows: GetAdaptersAddresses + SetInterfaceDnsSettings (no PowerShell/WMI); the previous settings are saved next to
//! the executable so they can be restored even after a crash.

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[allow(dead_code)]
pub struct IfaceBackup {
    /// Interface GUID ("{...}")
    #[serde(default)]
    pub guid: String,
    /// legacy (0.2/0.3 builds)
    #[serde(default)]
    pub index: u32,
    pub alias: String,
    /// Static servers from the registry ("" = obtained automatically / DHCP)
    #[serde(default)]
    pub v4: String,
    #[serde(default)]
    pub v6: String,
}

pub fn backup_path(dir: &Path) -> PathBuf {
    dir.join("dancedns-dns-backup.json")
}

pub fn is_active(dir: &Path) -> bool {
    backup_path(dir).exists()
}

#[cfg(windows)]
mod win {
    use anyhow::{anyhow, bail, Result};
    use windows_sys::core::GUID;
    use windows_sys::Win32::NetworkManagement::IpHelper::*;

    pub struct Iface {
        pub guid: String,
        pub alias: String,
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn parse_guid(s: &str) -> Option<GUID> {
        let hex: String = s.chars().filter(|c| c.is_ascii_hexdigit()).collect();
        if hex.len() != 32 {
            return None;
        }
        u128::from_str_radix(&hex, 16).ok().map(GUID::from_u128)
    }

    /// Connected adapters that have a default gateway (the ones Windows uses for DNS).
    pub fn active_interfaces() -> Result<Vec<Iface>> {
        unsafe {
            let mut size: u32 = 16 * 1024;
            for _ in 0..4 {
                let mut buf = vec![0u64; (size as usize + 7) / 8];
                let first = buf.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES_LH;
                let r = GetAdaptersAddresses(0, GAA_FLAG_INCLUDE_GATEWAYS, std::ptr::null(), first, &mut size);
                if r == 111 {
                    continue; // ERROR_BUFFER_OVERFLOW
                }
                if r != 0 {
                    bail!("GetAdaptersAddresses: код {r}");
                }
                let mut out = Vec::new();
                let mut cur = first;
                while !cur.is_null() {
                    let a = &*cur;
                    cur = a.Next;
                    // 1 = IfOperStatusUp, 24 = software loopback
                    if a.OperStatus != 1 || a.IfType == 24 || a.FirstGatewayAddress.is_null() || a.AdapterName.is_null() {
                        continue;
                    }
                    let guid = std::ffi::CStr::from_ptr(a.AdapterName as *const _).to_string_lossy().into_owned();
                    let alias = if a.FriendlyName.is_null() {
                        guid.clone()
                    } else {
                        let mut n = 0;
                        while *a.FriendlyName.add(n) != 0 {
                            n += 1;
                        }
                        String::from_utf16_lossy(std::slice::from_raw_parts(a.FriendlyName, n))
                    };
                    out.push(Iface { guid, alias });
                }
                return Ok(out);
            }
            bail!("GetAdaptersAddresses: буфер слишком мал")
        }
    }

    /// Static DNS servers from the registry ("" = automatic / DHCP).
    pub fn static_servers(guid: &str, v6: bool) -> String {
        use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
        let key = format!(
            "SYSTEM\\CurrentControlSet\\Services\\{}\\Parameters\\Interfaces\\{}",
            if v6 { "Tcpip6" } else { "Tcpip" },
            guid
        );
        let (k, v) = (wide(&key), wide("NameServer"));
        let mut buf = [0u16; 1024];
        let mut len = (buf.len() * 2) as u32;
        let r = unsafe { RegGetValueW(HKEY_LOCAL_MACHINE, k.as_ptr(), v.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), buf.as_mut_ptr() as *mut _, &mut len) };
        if r != 0 {
            return String::new();
        }
        let n = buf.iter().position(|&c| c == 0).unwrap_or(0);
        String::from_utf16_lossy(&buf[..n]).trim().to_string()
    }

    type SetDnsFn = unsafe extern "system" fn(GUID, *const DNS_INTERFACE_SETTINGS) -> u32;

    /// SetInterfaceDnsSettings exists on Windows 10 2004+; loaded dynamically so the exe still
    /// starts on older systems (they fall back to netsh).
    fn set_dns_fn() -> Option<SetDnsFn> {
        use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
        unsafe {
            let m = LoadLibraryW(wide("iphlpapi.dll").as_ptr());
            if m == 0 {
                return None;
            }
            GetProcAddress(m, b"SetInterfaceDnsSettings\0".as_ptr()).map(|f| std::mem::transmute(f))
        }
    }

    fn netsh(alias: &str, servers: &str, v6: bool) -> Result<()> {
        use std::os::windows::process::CommandExt;
        let fam = if v6 { "ipv6" } else { "ipv4" };
        let list: Vec<&str> = servers.split([',', ' ']).filter(|x| !x.is_empty()).collect();
        let mut cmds: Vec<Vec<String>> = Vec::new();
        if list.is_empty() {
            cmds.push(vec!["interface".into(), fam.into(), "set".into(), "dnsservers".into(), format!("name={alias}"), "source=dhcp".into()]);
        } else {
            for (i, ip) in list.iter().enumerate() {
                if i == 0 {
                    cmds.push(vec!["interface".into(), fam.into(), "set".into(), "dnsservers".into(), format!("name={alias}"), "static".into(), ip.to_string(), "primary".into(), "validate=no".into()]);
                } else {
                    cmds.push(vec!["interface".into(), fam.into(), "add".into(), "dnsservers".into(), format!("name={alias}"), ip.to_string(), format!("index={}", i + 1), "validate=no".into()]);
                }
            }
        }
        for c in cmds {
            let out = std::process::Command::new("netsh.exe").args(&c).creation_flags(0x0800_0000).output()?;
            if !out.status.success() {
                bail!("netsh: {}", String::from_utf8_lossy(&out.stdout).trim());
            }
        }
        Ok(())
    }

    /// Set (or with "" reset to automatic) the DNS servers of one interface.
    pub fn set_servers(guid: &str, alias: &str, servers: &str, v6: bool) -> Result<()> {
        let Some(set) = set_dns_fn() else { return netsh(alias, servers, v6) };
        let g = parse_guid(guid).ok_or_else(|| anyhow!("неверный GUID интерфейса {guid}"))?;
        let mut ns = wide(&servers.replace(' ', ","));
        let mut st: DNS_INTERFACE_SETTINGS = unsafe { std::mem::zeroed() };
        st.Version = DNS_INTERFACE_SETTINGS_VERSION1;
        st.Flags = (DNS_SETTING_NAMESERVER | if v6 { DNS_SETTING_IPV6 } else { 0 }) as u64;
        st.NameServer = ns.as_mut_ptr();
        let r = unsafe { set(g, &st) };
        if r != 0 {
            bail!("SetInterfaceDnsSettings ({}): код {r}", if v6 { "IPv6" } else { "IPv4" });
        }
        Ok(())
    }

    pub fn flush_cache() {
        use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
        unsafe {
            let m = LoadLibraryW(wide("dnsapi.dll").as_ptr());
            if m != 0 {
                if let Some(f) = GetProcAddress(m, b"DnsFlushResolverCache\0".as_ptr()) {
                    let f: unsafe extern "system" fn() -> i32 = std::mem::transmute(f);
                    f();
                }
            }
        }
    }
}

#[cfg(windows)]
pub fn enable(dir: &Path, with_v6: bool) -> Result<()> {
    let bpath = backup_path(dir);
    if !bpath.exists() {
        let rows: Vec<IfaceBackup> = win::active_interfaces()?
            .into_iter()
            .map(|i| IfaceBackup { v4: win::static_servers(&i.guid, false), v6: win::static_servers(&i.guid, true), guid: i.guid, alias: i.alias, index: 0 })
            .collect();
        if rows.is_empty() {
            bail!("не найдено активных сетевых подключений");
        }
        std::fs::write(&bpath, serde_json::to_string_pretty(&rows)?)?;
    }
    let rows: Vec<IfaceBackup> = serde_json::from_str(&std::fs::read_to_string(&bpath)?)?;
    let mut errors = Vec::new();
    for r in rows.iter().filter(|r| !r.guid.is_empty()) {
        if let Err(e) = win::set_servers(&r.guid, &r.alias, "127.0.0.1", false) {
            errors.push(format!("{}: {e:#}", r.alias));
        }
        if with_v6 {
            if let Err(e) = win::set_servers(&r.guid, &r.alias, "::1", true) {
                tracing::warn!("{}: {e:#}", r.alias);
            }
        }
    }
    win::flush_cache();
    if errors.len() == rows.len() {
        bail!("не удалось сменить DNS: {}", errors.join("; "));
    }
    for e in errors {
        tracing::warn!("{e}");
    }
    Ok(())
}

#[cfg(windows)]
pub fn disable(dir: &Path) -> Result<()> {
    let bpath = backup_path(dir);
    if !bpath.exists() {
        return Ok(());
    }
    let rows: Vec<IfaceBackup> = serde_json::from_str(&std::fs::read_to_string(&bpath)?).unwrap_or_default();
    let clean = |s: &str| -> String {
        s.split([',', ' ']).map(str::trim).filter(|x| x.parse::<std::net::IpAddr>().is_ok()).collect::<Vec<_>>().join(",")
    };
    for r in rows.iter().filter(|r| !r.guid.is_empty()) {
        if let Err(e) = win::set_servers(&r.guid, &r.alias, &clean(&r.v4), false) {
            tracing::warn!("{}: {e:#}", r.alias);
        }
        if let Err(e) = win::set_servers(&r.guid, &r.alias, &clean(&r.v6), true) {
            tracing::warn!("{}: {e:#}", r.alias);
        }
    }
    win::flush_cache();
    std::fs::remove_file(&bpath)?;
    Ok(())
}

#[cfg(not(windows))]
pub fn enable(_dir: &Path, _with_v6: bool) -> Result<()> {
    bail!("автонастройка системного DNS поддерживается только в Windows")
}

#[cfg(not(windows))]
pub fn disable(dir: &Path) -> Result<()> {
    let _ = std::fs::remove_file(backup_path(dir));
    Ok(())
}
