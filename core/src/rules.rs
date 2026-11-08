//! Rule engine: first enabled rule that matches process + domain + query type wins.

use crate::config::{ActionKind, RuleConfig};
use glob::{MatchOptions, Pattern};

const OPTS: MatchOptions = MatchOptions {
    case_sensitive: false,
    require_literal_separator: false,
    require_literal_leading_dot: false,
};

#[derive(Debug, Clone)]
enum DomainPat {
    /// `example.com` → example.com and *.example.com
    Suffix(String),
    Glob(Pattern),
}

impl DomainPat {
    fn parse(s: &str) -> Option<Self> {
        let s = s.trim().trim_end_matches('.').to_lowercase();
        if s.is_empty() {
            return None;
        }
        if let Some(rest) = s.strip_prefix("*.") {
            if !rest.contains(['*', '?', '[']) {
                return Some(DomainPat::Suffix(rest.to_string()));
            }
        }
        if s.contains(['*', '?', '[']) {
            Pattern::new(&s).ok().map(DomainPat::Glob)
        } else {
            Some(DomainPat::Suffix(s))
        }
    }

    fn matches(&self, domain: &str) -> bool {
        match self {
            DomainPat::Suffix(sfx) => {
                domain == sfx || (domain.len() > sfx.len() && domain.ends_with(sfx.as_str()) && domain.as_bytes()[domain.len() - sfx.len() - 1] == b'.')
            }
            DomainPat::Glob(p) => p.matches_with(domain, OPTS),
        }
    }
}

fn split(s: &str) -> impl Iterator<Item = &str> {
    s.split([',', ';', '\n']).map(str::trim).filter(|x| !x.is_empty())
}

fn globs(s: &str) -> Vec<Pattern> {
    split(s).filter_map(|p| Pattern::new(&p.to_lowercase()).ok()).collect()
}

#[derive(Debug, Clone)]
pub struct CompiledRule {
    pub name: String,
    process: Vec<Pattern>,
    process_path: Vec<Pattern>,
    domain: Vec<DomainPat>,
    qtypes: Vec<String>,
    pub action: ActionKind,
    pub pool: String,
    pub sinkhole: Option<String>,
    pub ip: String,
}

#[derive(Debug, Clone)]
pub struct Matched {
    pub rule: String,
    pub action: ActionKind,
    pub pool: String,
    pub sinkhole: Option<String>,
    pub ip: String,
}

pub struct RuleEngine {
    rules: Vec<CompiledRule>,
    default_pool: String,
}

impl RuleEngine {
    pub fn new(raw: &[RuleConfig], default_pool: &str) -> Self {
        let rules = raw
            .iter()
            .filter(|r| r.enabled)
            .map(|r| CompiledRule {
                name: r.name.clone(),
                process: globs(&r.process),
                process_path: globs(&r.process_path),
                domain: split(&r.domain).filter_map(DomainPat::parse).collect(),
                qtypes: split(&r.qtype).map(|q| q.to_uppercase()).filter(|q| q != "ANY" && q != "*").collect(),
                action: r.action,
                pool: r.pool.clone(),
                sinkhole: Some(r.sinkhole.trim().to_string()).filter(|s| !s.is_empty()),
                ip: r.ip.trim().to_string(),
            })
            .collect();
        Self { rules, default_pool: default_pool.to_string() }
    }

    pub fn evaluate(&self, process: Option<&str>, path: Option<&str>, domain: &str, qtype: &str) -> Matched {
        let domain = domain.trim_end_matches('.').to_lowercase();
        let process = process.map(str::to_lowercase);
        let path = path.map(|p| p.replace('/', "\\").to_lowercase()).filter(|p| !p.is_empty());
        let path_unix = path.as_ref().map(|p| p.replace('\\', "/"));

        for r in &self.rules {
            if !r.process.is_empty() {
                match process.as_deref() {
                    Some(p) if r.process.iter().any(|pat| pat.matches_with(p, OPTS)) => {}
                    _ => continue,
                }
            }
            if !r.process_path.is_empty() {
                match (path.as_deref(), path_unix.as_deref()) {
                    (Some(p), Some(pu)) if r.process_path.iter().any(|pat| pat.matches_with(p, OPTS) || pat.matches_with(pu, OPTS)) => {}
                    _ => continue,
                }
            }
            if !r.domain.is_empty() && !r.domain.iter().any(|d| d.matches(&domain)) {
                continue;
            }
            if !r.qtypes.is_empty() && !r.qtypes.iter().any(|q| q.eq_ignore_ascii_case(qtype)) {
                continue;
            }
            return Matched {
                rule: r.name.clone(),
                action: r.action,
                pool: r.pool.clone(),
                sinkhole: r.sinkhole.clone(),
                ip: r.ip.clone(),
            };
        }
        Matched {
            rule: "По умолчанию".into(),
            action: ActionKind::Route,
            pool: self.default_pool.clone(),
            sinkhole: None,
            ip: String::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(process: &str, path: &str, domain: &str, qtype: &str) -> RuleConfig {
        RuleConfig {
            name: "t".into(),
            enabled: true,
            process: process.into(),
            process_path: path.into(),
            domain: domain.into(),
            qtype: qtype.into(),
            action: ActionKind::Block,
            pool: String::new(),
            sinkhole: String::new(),
            ip: String::new(),
            description: String::new(),
        }
    }

    fn hit(rule: RuleConfig, p: Option<&str>, path: Option<&str>, d: &str, q: &str) -> bool {
        RuleEngine::new(&[rule], "default").evaluate(p, path, d, q).action == ActionKind::Block
    }

    #[test]
    fn domain_suffix() {
        assert!(hit(r("", "", "example.com", ""), None, None, "example.com.", "A"));
        assert!(hit(r("", "", "example.com", ""), None, None, "a.b.Example.com", "A"));
        assert!(!hit(r("", "", "example.com", ""), None, None, "badexample.com", "A"));
        assert!(hit(r("", "", "*.example.com", ""), None, None, "x.example.com", "A"));
        assert!(hit(r("", "", "*telemetry*", ""), None, None, "v10.telemetry.microsoft.com", "A"));
        assert!(hit(r("", "", "foo.org, bar.org", ""), None, None, "bar.org", "A"));
    }

    #[test]
    fn process_and_qtype() {
        assert!(hit(r("chrome.exe, firefox.exe", "", "", ""), Some("Firefox.EXE"), None, "a.com", "A"));
        assert!(!hit(r("chrome.exe", "", "", ""), None, None, "a.com", "A"));
        assert!(hit(r("*fox*", "", "", "AAAA"), Some("firefox.exe"), None, "a.com", "AAAA"));
        assert!(!hit(r("*fox*", "", "", "AAAA"), Some("firefox.exe"), None, "a.com", "A"));
        assert!(hit(r("", r"C:\Games\*", "", ""), None, Some(r"c:\games\x\y.exe"), "a.com", "A"));
        assert!(hit(r("", "/usr/bin/*", "", ""), None, Some("/usr/bin/curl"), "a.com", "A"));
    }
}
