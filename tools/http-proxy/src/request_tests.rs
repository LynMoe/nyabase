use super::*;
use crate::config::MAX_REQUEST_HEADER_BYTES;
use tokio::io::AsyncWriteExt;

#[test]
fn parses_and_normalizes_exactly_one_host_header() {
    let head = b"GET / HTTP/1.1\r\nHost: App.Example.test:8080\r\n\r\n";
    assert_eq!(request_plan(head).unwrap().host, "app.example.test");
    assert!(request_plan(
        b"GET / HTTP/1.1\r\nHost: one.example.test\r\nHost: two.example.test\r\n\r\n"
    )
    .is_err());
}

#[test]
fn forces_one_fixed_body_request_per_connection() {
    let plan = request_plan(b"POST / HTTP/1.1\r\nHost: app.example.test\r\nContent-Length: 4\r\nConnection: keep-alive\r\n\r\n").unwrap();
    assert!(matches!(plan.mode, RequestMode::FixedBody { body_len: 4 }));
    assert!(String::from_utf8(plan.header)
        .unwrap()
        .contains("Connection: close\r\n"));
    assert!(initial_body_bytes_allowed(4, 4));
    assert!(!initial_body_bytes_allowed(4, 5));
    assert!(request_plan(
            b"POST / HTTP/1.1\r\nHost: app.example.test\r\nContent-Length: 4\r\nContent-Length: 4\r\n\r\n"
        )
        .is_err());
    assert!(request_plan(
        b"GET http://attacker.invalid/ HTTP/1.1\r\nHost: app.example.test\r\n\r\n"
    )
    .is_err());
}

#[test]
fn accepts_only_bounded_unambiguous_rfc6455_upgrades() {
    let valid = b"GET /socket HTTP/1.1\r\nHost: app.example.test\r\nConnection: keep-alive, Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n";
    let plan = request_plan(valid).unwrap();
    assert!(matches!(plan.mode, RequestMode::WebSocket { .. }));
    let rewritten = String::from_utf8(plan.header).unwrap();
    assert!(rewritten.contains("Upgrade: websocket\r\nConnection: Upgrade\r\n"));

    for invalid in [
            b"GET / HTTP/1.1\r\nHost: app.example.test\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n".as_slice(),
            b"GET / HTTP/1.1\r\nHost: app.example.test\r\nConnection: Upgrade\r\nUpgrade: h2c\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n".as_slice(),
            b"GET / HTTP/1.1\r\nHost: app.example.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n".as_slice(),
            b"GET / HTTP/1.1\r\nHost: app.example.test\r\nConnection: Upgrade\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n".as_slice(),
            b"GET / HTTP/1.1\r\nHost: app.example.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 12\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n".as_slice(),
            b"GET / HTTP/1.1\r\nHost: app.example.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: invalid\r\n\r\n".as_slice(),
            b"GET / HTTP/1.1\r\nHost: app.example.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nTransfer-Encoding: chunked\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n".as_slice(),
            b"GET / HTTP/1.1\r\nHost: app.example.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nExpect: 100-continue\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n".as_slice(),
            b"CONNECT app.example.test:443 HTTP/1.1\r\nHost: app.example.test\r\n\r\n".as_slice(),
        ] {
            assert!(request_plan(invalid).is_err());
        }
}

#[tokio::test]
async fn rejects_a_terminated_header_larger_than_the_limit() {
    let (mut writer, mut reader) = tokio::io::duplex(MAX_REQUEST_HEADER_BYTES + 2048);
    let mut oversized = b"GET / HTTP/1.1\r\nHost: app.example.test\r\nX-Fill: ".to_vec();
    oversized.resize(MAX_REQUEST_HEADER_BYTES + 1, b'a');
    oversized.extend_from_slice(b"\r\n\r\n");
    let write = tokio::spawn(async move { writer.write_all(&oversized).await });

    assert!(read_request_head(&mut reader).await.is_err());
    write.await.unwrap().unwrap();
}
