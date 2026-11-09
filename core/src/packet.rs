//! Minimal IPv4/IPv6 + UDP packet parsing/building for the WinDivert interceptor.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

pub struct Parsed {
    pub src: IpAddr,
    pub dst: IpAddr,
    pub sport: u16,
    pub dport: u16,
    pub payload: std::ops::Range<usize>,
}

pub fn parse(p: &[u8]) -> Option<Parsed> {
    let (src, dst, udp) = match p.first()? >> 4 {
        4 => {
            let ihl = ((p[0] & 0x0f) as usize) * 4;
            if p.len() < ihl + 8 || p[9] != 17 || (u16::from_be_bytes([p[6], p[7]]) & 0x3fff) != 0 {
                return None; // not UDP, or a fragment
            }
            let s = Ipv4Addr::new(p[12], p[13], p[14], p[15]);
            let d = Ipv4Addr::new(p[16], p[17], p[18], p[19]);
            (IpAddr::V4(s), IpAddr::V4(d), ihl)
        }
        6 => {
            if p.len() < 48 || p[6] != 17 {
                return None; // extension headers are not handled; let them pass
            }
            let s: [u8; 16] = p[8..24].try_into().ok()?;
            let d: [u8; 16] = p[24..40].try_into().ok()?;
            (IpAddr::V6(Ipv6Addr::from(s)), IpAddr::V6(Ipv6Addr::from(d)), 40)
        }
        _ => return None,
    };
    let sport = u16::from_be_bytes([p[udp], p[udp + 1]]);
    let dport = u16::from_be_bytes([p[udp + 2], p[udp + 3]]);
    let ulen = u16::from_be_bytes([p[udp + 4], p[udp + 5]]) as usize;
    let end = (udp + ulen).min(p.len());
    if end < udp + 8 + 12 {
        return None;
    }
    Some(Parsed { src, dst, sport, dport, payload: udp + 8..end })
}

/// Build the answer packet: swap addresses/ports, put the DNS reply as payload.
pub fn build_reply(q: &Parsed, dns: &[u8]) -> Vec<u8> {
    let ulen = 8 + dns.len();
    let mut out = Vec::with_capacity(40 + ulen);
    match (q.dst, q.src) {
        (IpAddr::V4(from), IpAddr::V4(to)) => {
            let total = 20 + ulen;
            out.extend_from_slice(&[0x45, 0, (total >> 8) as u8, total as u8, 0, 0, 0x40, 0, 64, 17, 0, 0]);
            out.extend_from_slice(&from.octets());
            out.extend_from_slice(&to.octets());
        }
        (IpAddr::V6(from), IpAddr::V6(to)) => {
            out.extend_from_slice(&[0x60, 0, 0, 0, (ulen >> 8) as u8, ulen as u8, 17, 64]);
            out.extend_from_slice(&from.octets());
            out.extend_from_slice(&to.octets());
        }
        _ => unreachable!(),
    }
    out.extend_from_slice(&q.dport.to_be_bytes());
    out.extend_from_slice(&q.sport.to_be_bytes());
    out.extend_from_slice(&(ulen as u16).to_be_bytes());
    out.extend_from_slice(&[0, 0]);
    out.extend_from_slice(dns);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reply_v4_roundtrip() {
        let dns = [0x12u8, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0];
        let q = Parsed {
            src: "192.168.1.5".parse().unwrap(),
            dst: "8.8.8.8".parse().unwrap(),
            sport: 50000,
            dport: 53,
            payload: 0..0,
        };
        let r = build_reply(&q, &dns);
        let p = parse(&r).unwrap();
        assert_eq!(p.src, q.dst);
        assert_eq!(p.dst, q.src);
        assert_eq!((p.sport, p.dport), (53, 50000));
        assert_eq!(&r[p.payload], &dns);
    }

    #[test]
    fn reply_v6_roundtrip() {
        let dns = [0u8; 20];
        let q = Parsed { src: "fe80::1".parse().unwrap(), dst: "2001:4860::8888".parse().unwrap(), sport: 4000, dport: 53, payload: 0..0 };
        let r = build_reply(&q, &dns);
        let p = parse(&r).unwrap();
        assert_eq!((p.src, p.dst, p.sport, p.dport), (q.dst, q.src, 53, 4000));
        assert_eq!(r[p.payload].len(), 20);
    }
}
