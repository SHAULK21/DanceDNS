//! Helpers for building and inspecting DNS messages.

use bytes::Bytes;
use hickory_proto::op::{Message, MessageType, OpCode, Query, ResponseCode};
use hickory_proto::rr::rdata::{A, AAAA};
use hickory_proto::rr::{Name, RData, Record, RecordType};
use serde::Serialize;
use std::net::IpAddr;
use std::str::FromStr;

fn base_response(q: &Message, rcode: ResponseCode) -> Message {
    let mut m = Message::new();
    m.set_id(q.id());
    m.set_message_type(MessageType::Response);
    m.set_op_code(OpCode::Query);
    m.set_recursion_desired(q.recursion_desired());
    m.set_recursion_available(true);
    m.set_response_code(rcode);
    for qq in q.queries() {
        m.add_query(qq.clone());
    }
    m
}

/// Answer with a fixed address (A or AAAA depending on query type). Other query types
/// get an empty NOERROR answer. An IPv4 address answers AAAA with `::` only if it is 0.0.0.0.
pub fn synthesize_ip(q: &Message, ip: IpAddr, ttl: u32) -> Bytes {
    let mut m = base_response(q, ResponseCode::NoError);
    if let Some(qq) = q.queries().first() {
        let rdata = match (qq.query_type(), ip) {
            (RecordType::A, IpAddr::V4(v4)) => Some(RData::A(A(v4))),
            (RecordType::AAAA, IpAddr::V6(v6)) => Some(RData::AAAA(AAAA(v6))),
            (RecordType::AAAA, IpAddr::V4(v4)) if v4.is_unspecified() => Some(RData::AAAA(AAAA(std::net::Ipv6Addr::UNSPECIFIED))),
            (RecordType::A, IpAddr::V6(v6)) if v6.is_unspecified() => Some(RData::A(A(std::net::Ipv4Addr::UNSPECIFIED))),
            _ => None,
        };
        if let Some(r) = rdata {
            m.add_answer(Record::from_rdata(qq.name().clone(), ttl, r));
        }
    }
    m.to_vec().map(Bytes::from).unwrap_or_default()
}

pub fn synthesize_rcode(q: &Message, rcode: ResponseCode) -> Bytes {
    base_response(q, rcode).to_vec().map(Bytes::from).unwrap_or_default()
}

/// Build a SERVFAIL from raw bytes even if the query can't be fully parsed.
pub fn servfail(q: &Message) -> Bytes {
    synthesize_rcode(q, ResponseCode::ServFail)
}

pub fn set_id(resp: &Bytes, id: u16) -> Bytes {
    let mut v = resp.to_vec();
    if v.len() >= 2 {
        v[..2].copy_from_slice(&id.to_be_bytes());
    }
    Bytes::from(v)
}

/// If a UDP response exceeds what the client accepts, return a truncated (TC) reply
/// so the client retries over TCP.
pub fn fit_udp(q: &Message, resp: Bytes) -> Bytes {
    let limit = q.extensions().as_ref().map(|e| e.max_payload().max(512)).unwrap_or(512) as usize;
    if resp.len() <= limit {
        return resp;
    }
    let mut m = base_response(q, ResponseCode::NoError);
    if let Ok(r) = Message::from_vec(&resp) {
        m.set_response_code(r.response_code());
    }
    m.set_truncated(true);
    m.to_vec().map(Bytes::from).unwrap_or(resp)
}

#[derive(Serialize, Clone, Debug)]
pub struct AnswerView {
    pub name: String,
    #[serde(rename = "type")]
    pub rtype: String,
    pub ttl: u32,
    pub data: String,
}

pub struct ResponseInfo {
    pub rcode: String,
    pub answers: Vec<AnswerView>,
    /// TTL used for caching (min answer TTL, or SOA minimum for negative answers).
    pub cache_ttl: Option<u32>,
    pub dnssec_ad: bool,
}

pub fn inspect(resp: &[u8]) -> Option<ResponseInfo> {
    let m = Message::from_vec(resp).ok()?;
    let answers: Vec<AnswerView> = m
        .answers()
        .iter()
        .map(|r| AnswerView {
            name: r.name().to_utf8(),
            rtype: r.record_type().to_string(),
            ttl: r.ttl(),
            data: r.data().map(|d| d.to_string()).unwrap_or_default(),
        })
        .collect();
    let cacheable = matches!(m.response_code(), ResponseCode::NoError | ResponseCode::NXDomain) && !m.truncated();
    let cache_ttl = if !cacheable {
        None
    } else if let Some(min) = m.answers().iter().map(|r| r.ttl()).min() {
        Some(min)
    } else {
        // negative caching via SOA
        m.name_servers()
            .iter()
            .find_map(|r| match r.data() {
                Some(RData::SOA(soa)) => Some(soa.minimum().min(r.ttl())),
                _ => None,
            })
            .or(Some(60))
    };
    Some(ResponseInfo {
        rcode: m.response_code().to_string(),
        answers,
        cache_ttl,
        dnssec_ad: m.authentic_data(),
    })
}

/// Build a wire query for the "test resolve" feature.
pub fn build_query(domain: &str, qtype: &str) -> anyhow::Result<Vec<u8>> {
    let name = Name::from_str(domain.trim())?;
    let rtype = RecordType::from_str(&qtype.trim().to_uppercase())?;
    let mut m = Message::new();
    m.set_id(rand_id());
    m.set_recursion_desired(true);
    m.add_query(Query::query(name, rtype));
    Ok(m.to_vec()?)
}

fn rand_id() -> u16 {
    use std::time::{SystemTime, UNIX_EPOCH};
    (SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(1) & 0xffff) as u16
}
