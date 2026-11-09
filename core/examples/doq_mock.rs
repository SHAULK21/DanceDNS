//! Test-only DNS-over-QUIC server: answers every A query with 93.184.215.14.
//! cargo run --example doq_mock -- <listen addr> <dir for ca.pem>
use hickory_proto::op::{Message, MessageType};
use hickory_proto::rr::{rdata::A, RData, Record, RecordType};
use std::sync::Arc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let addr = args.get(1).cloned().unwrap_or("127.0.0.1:8853".into()).parse()?;
    let dir = std::path::PathBuf::from(args.get(2).cloned().unwrap_or(".".into()));

    let ca_key = rcgen::KeyPair::generate()?;
    let mut ca_params = rcgen::CertificateParams::new(vec![])?;
    ca_params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    ca_params.distinguished_name.push(rcgen::DnType::CommonName, "DoQ test CA");
    let ca = ca_params.self_signed(&ca_key)?;
    std::fs::write(dir.join("doq-ca.pem"), ca.pem())?;
    let key = rcgen::KeyPair::generate()?;
    let leaf = rcgen::CertificateParams::new(vec!["mock.doq".into()])?.signed_by(&key, &ca, &ca_key)?;

    let mut tls = rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_protocol_versions(&[&rustls::version::TLS13])?
        .with_no_client_auth()
        .with_single_cert(vec![leaf.der().clone()], rustls::pki_types::PrivateKeyDer::Pkcs8(key.serialize_der().into()))?;
    tls.alpn_protocols = vec![b"doq".to_vec()];
    let cfg = quinn::ServerConfig::with_crypto(Arc::new(quinn::crypto::rustls::QuicServerConfig::try_from(tls)?));
    let ep = quinn::Endpoint::server(cfg, addr)?;
    println!("DoQ mock on {addr}");
    while let Some(inc) = ep.accept().await {
        tokio::spawn(async move {
            let Ok(conn) = inc.await else { return };
            while let Ok((mut send, mut recv)) = conn.accept_bi().await {
                tokio::spawn(async move {
                    let data = recv.read_to_end(65537).await.ok()?;
                    let q = Message::from_vec(&data[2..]).ok()?;
                    assert_eq!(q.id(), 0, "RFC 9250: ID must be 0");
                    let mut r = q.clone();
                    r.set_message_type(MessageType::Response);
                    if let Some(qq) = q.queries().first() {
                        if qq.query_type() == RecordType::A {
                            r.add_answer(Record::from_rdata(qq.name().clone(), 120, RData::A(A::new(93, 184, 215, 14))));
                        }
                    }
                    let out = r.to_vec().ok()?;
                    let mut buf = (out.len() as u16).to_be_bytes().to_vec();
                    buf.extend(out);
                    send.write_all(&buf).await.ok()?;
                    send.finish().ok()
                });
            }
        });
    }
    Ok(())
}
