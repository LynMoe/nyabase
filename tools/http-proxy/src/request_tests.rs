use super::*;
use crate::config::MAX_REQUEST_HEADER_BYTES;
use crate::test_support::*;
use tokio::io::AsyncWriteExt;

#[test]
fn parses_and_normalizes_exactly_one_host_header() {
    let head = b"GET / HTTP/1.1\r\nHost: App.Example.test:8080\r\n\r\n";
    assert_eq!(
        request_plan(head, &test_client()).unwrap().host,
        "app.example.test"
    );
    assert!(request_plan(
        b"GET / HTTP/1.1\r\nHost: one.example.test\r\nHost: two.example.test\r\n\r\n",
        &test_client()
    )
    .is_err());
}

#[test]
fn forces_one_fixed_body_request_per_connection() {
    let plan = request_plan(b"POST / HTTP/1.1\r\nHost: app.example.test\r\nContent-Length: 4\r\nConnection: keep-alive\r\n\r\n", &test_client()).unwrap();
    assert!(matches!(plan.mode, RequestMode::FixedBody { body_len: 4 }));
    assert!(String::from_utf8(plan.header)
        .unwrap()
        .contains("Connection: close\r\n"));
    assert!(initial_body_bytes_allowed(4, 4));
    assert!(!initial_body_bytes_allowed(4, 5));
    assert!(request_plan(
            b"POST / HTTP/1.1\r\nHost: app.example.test\r\nContent-Length: 4\r\nContent-Length: 4\r\n\r\n", &test_client()
        )
        .is_err());
    assert!(request_plan(
        b"GET http://attacker.invalid/ HTTP/1.1\r\nHost: app.example.test\r\n\r\n",
        &test_client()
    )
    .is_err());
}

#[test]
fn accepts_only_bounded_unambiguous_rfc6455_upgrades() {
    let valid = b"GET /socket HTTP/1.1\r\nHost: app.example.test\r\nConnection: keep-alive, Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n";
    let plan = request_plan(valid, &test_client()).unwrap();
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
            assert!(request_plan(invalid, &test_client()).is_err());
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

#[test]
fn client_forwarding_headers_are_replaced_with_the_proxy_view() {
    let head = b"GET / HTTP/1.1\r\nHost: App.Example.test:8080\r\nX-Forwarded-For: 10.0.0.1\r\nx-forwarded-proto: https\r\nX-Forwarded-Host: evil.test\r\nX-Forwarded-Port: 1\r\nForwarded: for=10.0.0.1\r\nX-Real-IP: 10.0.0.1\r\nX-Other: kept\r\n\r\n";
    let client = ClientContext {
        peer_ip: "::ffff:198.51.100.7".parse().unwrap(),
        https: true,
    };
    let header = String::from_utf8(request_plan(head, &client).unwrap().header).unwrap();
    assert!(!header.contains("10.0.0.1"), "{header}");
    assert!(!header.contains("evil.test"), "{header}");
    assert!(!header.to_ascii_lowercase().contains("x-forwarded-port"));
    assert!(!header.to_ascii_lowercase().contains("forwarded: for"));
    assert!(
        header.contains("X-Forwarded-For: 198.51.100.7\r\n"),
        "{header}"
    );
    assert!(header.contains("X-Forwarded-Proto: https\r\n"));
    assert!(header.contains("X-Forwarded-Host: App.Example.test:8080\r\n"));
    assert!(header.contains("X-Real-IP: 198.51.100.7\r\n"));
    assert!(header.contains("X-Other: kept\r\n"));
    assert_eq!(header.matches("X-Forwarded-For").count(), 1);

    let ipv6 = ClientContext {
        peer_ip: "2001:db8::1".parse().unwrap(),
        https: false,
    };
    let websocket = b"GET /socket HTTP/1.1\r\nHost: app.example.test\r\nX-Forwarded-For: 10.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n";
    let header = String::from_utf8(request_plan(websocket, &ipv6).unwrap().header).unwrap();
    assert!(header.contains("X-Forwarded-For: 2001:db8::1\r\nX-Forwarded-Proto: http\r\n"));
    assert!(!header.contains("10.0.0.1"));
}

#[test]
fn underscore_spellings_of_proxy_headers_are_dropped() {
    // CGI/WSGI-style servers read `X_Forwarded_For` as X-Forwarded-For.
    let head = b"POST / HTTP/1.1\r\nHost: app.example.test\r\nX_Forwarded_For: 6.6.6.6\r\nX-Real_IP: 6.6.6.6\r\nx_forwarded_proto: https\r\nX-Forwarded_Host: evil.test\r\nContent-Length: 0\r\nContent_Length: 4\r\nTransfer_Encoding: chunked\r\nKeep_Alive: 1\r\nProxy_Connection: keep-alive\r\nSec_WebSocket_Key: x\r\nX_Api_Key: kept\r\n\r\n";
    let plan = request_plan(head, &test_client()).unwrap();
    assert!(matches!(plan.mode, RequestMode::FixedBody { body_len: 0 }));
    let header = String::from_utf8(plan.header).unwrap();
    assert!(!header.contains("6.6.6.6"), "{header}");
    assert!(!header.contains("evil.test"), "{header}");
    for dropped in [
        "content_length",
        "transfer_encoding",
        "keep_alive",
        "proxy_connection",
        "sec_websocket",
    ] {
        assert!(!header.to_ascii_lowercase().contains(dropped), "{header}");
    }
    assert!(
        header.contains("X-Forwarded-For: 192.0.2.10\r\n"),
        "{header}"
    );
    assert!(header.contains("X-Forwarded-Proto: http\r\n"));
    assert!(header.contains("Content-Length: 0\r\n"));
    // Underscore names that collide with nothing the proxy owns are kept.
    assert!(header.contains("X_Api_Key: kept\r\n"));
}

#[test]
fn only_plain_chunked_transfer_coding_is_accepted() {
    let plan = request_plan(
        b"POST /git-receive-pack HTTP/1.1\r\nHost: app.example.test\r\nTransfer-Encoding: Chunked\r\n\r\n",
        &test_client(),
    )
    .unwrap();
    assert!(matches!(plan.mode, RequestMode::ChunkedBody));
    let header = String::from_utf8(plan.header).unwrap();
    assert_eq!(header.matches("Transfer-Encoding").count(), 1);
    assert!(header.contains("Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n"));

    for invalid in [
        // Smuggling classics: TE+CL, duplicated/listed/obfuscated codings.
        b"POST / HTTP/1.1\r\nHost: app.example.test\r\nTransfer-Encoding: chunked\r\nContent-Length: 4\r\n\r\n".as_slice(),
        b"POST / HTTP/1.1\r\nHost: app.example.test\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n".as_slice(),
        b"POST / HTTP/1.1\r\nHost: app.example.test\r\nTransfer-Encoding: chunked\r\nTransfer-Encoding: chunked\r\n\r\n".as_slice(),
        b"POST / HTTP/1.1\r\nHost: app.example.test\r\nTransfer-Encoding: gzip, chunked\r\n\r\n".as_slice(),
        b"POST / HTTP/1.1\r\nHost: app.example.test\r\nTransfer-Encoding: chunked, chunked\r\n\r\n".as_slice(),
        b"POST / HTTP/1.1\r\nHost: app.example.test\r\nTransfer-Encoding: identity\r\n\r\n".as_slice(),
        b"POST / HTTP/1.1\r\nHost: app.example.test\r\nTransfer-Encoding: xchunked\r\n\r\n".as_slice(),
        b"POST / HTTP/1.1\r\nHost: app.example.test\r\nTransfer-Encoding : chunked\r\n\r\n".as_slice(),
        b"POST / HTTP/1.1\r\nHost: app.example.test\r\nTransfer-Encoding:\x0bchunked\r\n\r\n".as_slice(),
        b"POST / HTTP/1.1\r\nHost: app.example.test\r\nTransfer-Encoding:\r\n chunked\r\n\r\n".as_slice(),
        b"POST / HTTP/1.1\r\nHost: app.example.test\r\nX-Pad: 1\r\n Transfer-Encoding: chunked\r\n\r\n".as_slice(),
        b"POST / HTTP/1.1\r\nHost: app.example.test\r\nTransfer-Encoding: chunked\nX: y\r\n\r\n".as_slice(),
        b"POST / HTTP/1.0\r\nHost: app.example.test\r\nTransfer-Encoding: chunked\r\n\r\n".as_slice(),
        b"POST / HTTP/1.1\r\nHost: app.example.test\r\nContent-Length: 4\r\nContent-Length: 5\r\n\r\n".as_slice(),
        b"POST / HTTP/1.1\r\nHost: app.example.test\r\nContent-Length: +4\r\n\r\n".as_slice(),
    ] {
        assert!(
            request_plan(invalid, &test_client()).is_err(),
            "accepted {:?}",
            String::from_utf8_lossy(invalid)
        );
    }
}

#[test]
fn expect_100_continue_is_answered_locally_and_stripped() {
    let plan = request_plan(
        b"POST /upload HTTP/1.1\r\nHost: app.example.test\r\nContent-Length: 4\r\nExpect: 100-Continue\r\n\r\n",
        &test_client(),
    )
    .unwrap();
    assert!(plan.expect_continue);
    assert!(!String::from_utf8(plan.header)
        .unwrap()
        .to_ascii_lowercase()
        .contains("expect"));

    // Nothing to continue: no body, or an HTTP/1.0 client.
    for no_interim in [
        b"GET / HTTP/1.1\r\nHost: app.example.test\r\nExpect: 100-continue\r\n\r\n".as_slice(),
        b"POST / HTTP/1.0\r\nHost: app.example.test\r\nContent-Length: 4\r\nExpect: 100-continue\r\n\r\n".as_slice(),
    ] {
        assert!(!request_plan(no_interim, &test_client()).unwrap().expect_continue);
    }
    for invalid in [
        b"POST / HTTP/1.1\r\nHost: app.example.test\r\nContent-Length: 4\r\nExpect: something-else\r\n\r\n".as_slice(),
        b"POST / HTTP/1.1\r\nHost: app.example.test\r\nContent-Length: 4\r\nExpect: 100-continue\r\nExpect: 100-continue\r\n\r\n".as_slice(),
    ] {
        assert!(request_plan(invalid, &test_client()).is_err());
    }
}
