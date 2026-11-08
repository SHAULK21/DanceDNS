//! Point the operating system's DNS at DanceDNS (and back).
//! Windows: PowerShell NetTCPIP/DnsClient cmdlets; the previous settings are saved next to
//! the executable so they can be restored even after a crash.

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[allow(dead_code)]
pub struct IfaceBackup {
    pub index: u32,
    pub alias: String,
    /// Static servers from the registry ("" = obtained automatically / DHCP)
    #[serde(default)]
    pub v4: String,
    #[serde(default)]
    pub v6: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct IfaceState {
    pub alias: String,
    pub servers: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct SysDnsStatus {
    pub supported: bool,
    pub active: bool,
    pub interfaces: Vec<IfaceState>,
    pub note: Option<String>,
}

pub fn backup_path(dir: &Path) -> PathBuf {
    dir.join("dancedns-dns-backup.json")
}

pub fn is_active(dir: &Path) -> bool {
    backup_path(dir).exists()
}

#[cfg(windows)]
fn powershell(script: &str) -> Result<String> {
    use std::os::windows::process::CommandExt;
    let out = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .output()?;
    if !out.status.success() {
        bail!("PowerShell: {}", String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(windows)]
pub fn status(dir: &Path) -> SysDnsStatus {
    let script = r#"
$ErrorActionPreference='SilentlyContinue'
$r=@()
foreach($c in (Get-NetIPConfiguration | Where-Object { $_.NetAdapter.Status -eq 'Up' -and ($_.IPv4DefaultGateway -or $_.IPv6DefaultGateway) })){
  $s=@(Get-DnsClientServerAddress -InterfaceIndex $c.InterfaceIndex | ForEach-Object { $_.ServerAddresses } | Where-Object { $_ -notlike 'fec0:*' })
  $r += [pscustomobject]@{ alias=$c.InterfaceAlias; servers=$s }
}
ConvertTo-Json -InputObject @($r) -Compress -Depth 3
"#;
    #[derive(Deserialize)]
    struct Row {
        alias: String,
        #[serde(default)]
        servers: Option<serde_json::Value>,
    }
    let mut interfaces = Vec::new();
    let mut note = None;
    match powershell(script) {
        Ok(out) => {
            let rows: Vec<Row> = serde_json::from_str(out.trim()).unwrap_or_default();
            for r in rows {
                let servers = match r.servers {
                    Some(serde_json::Value::Array(a)) => a.into_iter().filter_map(|v| v.as_str().map(String::from)).collect(),
                    Some(serde_json::Value::String(s)) => vec![s],
                    _ => vec![],
                };
                interfaces.push(IfaceState { alias: r.alias, servers });
            }
        }
        Err(e) => note = Some(format!("{e:#}")),
    }
    SysDnsStatus { supported: true, active: is_active(dir), interfaces, note }
}

#[cfg(windows)]
pub fn enable(dir: &Path, with_v6: bool) -> Result<()> {
    let bpath = backup_path(dir);
    if !bpath.exists() {
        let script = r#"
$ErrorActionPreference='Stop'
$r=@()
foreach($c in (Get-NetIPConfiguration | Where-Object { $_.NetAdapter.Status -eq 'Up' -and ($_.IPv4DefaultGateway -or $_.IPv6DefaultGateway) })){
  $g=$c.NetAdapter.InterfaceGuid
  $v4=(Get-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces\$g" -Name NameServer -ErrorAction SilentlyContinue).NameServer
  $v6=(Get-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip6\Parameters\Interfaces\$g" -Name NameServer -ErrorAction SilentlyContinue).NameServer
  $r += [pscustomobject]@{ index=[uint32]$c.InterfaceIndex; alias=[string]$c.InterfaceAlias; v4=[string]$v4; v6=[string]$v6 }
}
ConvertTo-Json -InputObject @($r) -Compress
"#;
        let out = powershell(script)?;
        let rows: Vec<IfaceBackup> = serde_json::from_str(out.trim())
            .map_err(|e| anyhow::anyhow!("не удалось разобрать список интерфейсов: {e}: {out}"))?;
        if rows.is_empty() {
            bail!("не найдено активных сетевых подключений");
        }
        std::fs::write(&bpath, serde_json::to_string_pretty(&rows)?)?;
    }
    let rows: Vec<IfaceBackup> = serde_json::from_str(&std::fs::read_to_string(&bpath)?)?;
    let addrs = if with_v6 { "'127.0.0.1','::1'" } else { "'127.0.0.1'" };
    let mut script = String::from("$ErrorActionPreference='Stop'\n");
    for r in &rows {
        script.push_str(&format!("Set-DnsClientServerAddress -InterfaceIndex {} -ServerAddresses ({addrs})\n", r.index));
    }
    script.push_str("Clear-DnsClientCache\n");
    powershell(&script)?;
    Ok(())
}

#[cfg(windows)]
pub fn disable(dir: &Path) -> Result<()> {
    let bpath = backup_path(dir);
    if !bpath.exists() {
        return Ok(());
    }
    let rows: Vec<IfaceBackup> = serde_json::from_str(&std::fs::read_to_string(&bpath)?)?;
    let mut script = String::from("$ErrorActionPreference='Continue'\n");
    for r in &rows {
        script.push_str(&format!("Set-DnsClientServerAddress -InterfaceIndex {} -ResetServerAddresses\n", r.index));
        let list: Vec<String> = r
            .v4
            .split([',', ' '])
            .chain(r.v6.split([',', ' ']))
            .map(str::trim)
            .filter(|s| !s.is_empty() && s.parse::<std::net::IpAddr>().is_ok())
            .map(|s| format!("'{s}'"))
            .collect();
        if !list.is_empty() {
            script.push_str(&format!("Set-DnsClientServerAddress -InterfaceIndex {} -ServerAddresses ({})\n", r.index, list.join(",")));
        }
    }
    script.push_str("Clear-DnsClientCache\n");
    powershell(&script)?;
    std::fs::remove_file(&bpath)?;
    Ok(())
}

#[cfg(not(windows))]
pub fn status(dir: &Path) -> SysDnsStatus {
    let servers = std::fs::read_to_string("/etc/resolv.conf")
        .unwrap_or_default()
        .lines()
        .filter_map(|l| l.trim().strip_prefix("nameserver").map(|s| s.trim().to_string()))
        .collect();
    SysDnsStatus {
        supported: false,
        active: is_active(dir),
        interfaces: vec![IfaceState { alias: "/etc/resolv.conf".into(), servers }],
        note: Some("Автонастройка системного DNS сделана для Windows. В Linux укажите 127.0.0.1 вручную, например: sudo resolvectl dns <интерфейс> 127.0.0.1".into()),
    }
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
