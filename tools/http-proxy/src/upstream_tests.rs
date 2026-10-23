use super::*;
use crate::config::MAX_UPSTREAM_UPGRADE_HEADER_BYTES;
use crate::listener::handle_connection;
use crate::request::{find_header_end, read_request_head, request_plan, RequestMode};
use crate::snapshot::SnapshotStore;
use crate::test_support::*;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::time;

#[test]
fn validates_the_upstream_websocket_handshake_before_relay() {
    let expected = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=";
    assert!(validate_websocket_response(
            b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n",
            expected,
        )
        .is_ok());
    for invalid in [
            b"HTTP/1.1 200 OK\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n".as_slice(),
            b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: wrong\r\n\r\n".as_slice(),
            b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n".as_slice(),
            b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nContent-Length: 0\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n".as_slice(),
        ] {
            assert!(validate_websocket_response(invalid, expected).is_err());
        }
}

fn websocket_test_plan() -> (Vec<u8>, String) {
    let plan = request_plan(
            b"GET /socket HTTP/1.1\r\nHost: app.example.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n", &test_client()
        )
        .unwrap();
    let RequestMode::WebSocket { expected_accept } = plan.mode else {
        panic!("expected WebSocket request plan");
    };
    (plan.header, expected_accept)
}

fn websocket_accept_response(expected_accept: &str) -> Vec<u8> {
    format!(
            "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: {expected_accept}\r\n\r\n"
        )
        .into_bytes()
}

#[tokio::test]
async fn valid_websocket_upgrade_relays_bidirectional_bytes() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_port = listener.local_addr().unwrap().port();
    let (header, expected_accept) = websocket_test_plan();
    let response = websocket_accept_response(&expected_accept);
    let upstream = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let request = read_request_head(&mut socket).await.unwrap();
        assert!(String::from_utf8(request)
            .unwrap()
            .contains("Connection: Upgrade\r\n"));
        socket.write_all(&response).await.unwrap();
        let mut from_client = [0_u8; 17];
        socket.read_exact(&mut from_client).await.unwrap();
        assert_eq!(&from_client, b"client-frame-data");
        socket.write_all(b"server-frame-data").await.unwrap();
        socket.shutdown().await.unwrap();
    });

    let route = test_route(upstream_port);
    let runtime = test_runtime();
    let task_runtime = runtime.clone();
    let (mut client, mut proxy_side) = tokio::io::duplex(4096);
    let proxy = tokio::spawn(async move {
        proxy_websocket_upgrade(
            &mut proxy_side,
            &task_runtime,
            &route,
            header,
            &expected_accept,
            Duration::from_secs(1),
        )
        .await
    });

    let response = read_response_head(&mut client).await.unwrap();
    assert!(String::from_utf8(response)
        .unwrap()
        .starts_with("HTTP/1.1 101"));
    client.write_all(b"client-frame-data").await.unwrap();
    let mut from_server = [0_u8; 17];
    client.read_exact(&mut from_server).await.unwrap();
    assert_eq!(&from_server, b"server-frame-data");
    client.shutdown().await.unwrap();

    time::timeout(Duration::from_secs(1), proxy)
        .await
        .expect("WebSocket proxy did not finish")
        .unwrap()
        .unwrap();
    upstream.await.unwrap();
}

#[tokio::test]
async fn websocket_non_101_timeout_and_oversize_fail_closed() {
    async fn run_failure(response: Option<Vec<u8>>, deadline: Duration) -> (String, String) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_port = listener.local_addr().unwrap().port();
        let upstream = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let _ = read_request_head(&mut socket).await.unwrap();
            match response {
                Some(response) => {
                    let _ = socket.write_all(&response).await;
                    let _ = socket.shutdown().await;
                }
                None => std::future::pending::<()>().await,
            }
        });
        let (header, expected_accept) = websocket_test_plan();
        let route = test_route(upstream_port);
        let runtime = test_runtime();
        let (mut client, mut proxy_side) = tokio::io::duplex(4096);
        let error = proxy_websocket_upgrade(
            &mut proxy_side,
            &runtime,
            &route,
            header,
            &expected_accept,
            deadline,
        )
        .await
        .unwrap_err()
        .to_string();
        let mut rejection = Vec::new();
        client.read_to_end(&mut rejection).await.unwrap();
        upstream.abort();
        let _ = upstream.await;
        (error, String::from_utf8(rejection).unwrap())
    }

    let (error, rejection) = run_failure(
        Some(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n".to_vec()),
        Duration::from_secs(1),
    )
    .await;
    assert!(error.contains("did not accept"));
    assert!(rejection.starts_with("HTTP/1.1 502 Bad Gateway"));

    let (error, rejection) = run_failure(None, Duration::from_millis(10)).await;
    assert!(error.contains("deadline exceeded"));
    assert!(rejection.starts_with("HTTP/1.1 504 Gateway Timeout"));

    let mut oversized = b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nX-Fill: ".to_vec();
    oversized.resize(MAX_UPSTREAM_UPGRADE_HEADER_BYTES + 1, b'a');
    oversized.extend_from_slice(b"\r\n\r\n");
    let (error, rejection) = run_failure(Some(oversized), Duration::from_secs(1)).await;
    assert!(error.contains("too large"));
    assert!(rejection.starts_with("HTTP/1.1 502 Bad Gateway"));
}

#[tokio::test]
async fn websocket_tunnel_closes_when_route_authority_is_revoked() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_port = listener.local_addr().unwrap().port();
    let (_, expected_accept) = websocket_test_plan();
    let response = websocket_accept_response(&expected_accept);
    let upstream = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let _ = read_request_head(&mut socket).await.unwrap();
        socket.write_all(&response).await.unwrap();
        let mut byte = [0_u8; 1];
        let _ = socket.read(&mut byte).await;
    });

    let route = test_route(upstream_port);
    let store = Arc::new(SnapshotStore::default());
    store.store(test_snapshot(1, 30_000, vec![route])).unwrap();
    // An ordinary-request idle timeout far below the test's pauses must not
    // apply to an upgraded tunnel.
    let runtime = Arc::new({
        let mut runtime = Arc::try_unwrap(test_runtime()).ok().unwrap();
        runtime.limits.idle = Duration::from_millis(10);
        runtime
    });
    let (mut client, proxy_side) = tokio::io::duplex(4096);
    let handler_store = store.clone();
    let handler = tokio::spawn(handle_connection(
        proxy_side,
        "127.0.0.1:12345".parse().unwrap(),
        handler_store,
        runtime,
    ));
    client
            .write_all(b"GET /socket HTTP/1.1\r\nHost: app.example.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n")
            .await
            .unwrap();
    let response = read_response_head(&mut client).await.unwrap();
    assert!(String::from_utf8(response)
        .unwrap()
        .starts_with("HTTP/1.1 101"));

    time::sleep(Duration::from_millis(30)).await;
    assert!(
        !handler.is_finished(),
        "WebSocket tunnel inherited the ordinary HTTP request idle timeout"
    );

    store.store(test_snapshot(2, 30_000, Vec::new())).unwrap();
    let result = time::timeout(Duration::from_secs(1), handler)
        .await
        .expect("revoked WebSocket tunnel did not close")
        .unwrap();
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("authorization was revoked"));
    let mut byte = [0_u8; 1];
    assert_eq!(client.read(&mut byte).await.unwrap(), 0);
    upstream.await.unwrap();
}

#[tokio::test]
async fn early_websocket_bytes_are_rejected_as_smuggling() {
    let route = test_route(9);
    let runtime = test_runtime();
    let (header, _) = websocket_test_plan();
    let header_end = header.len();
    let mut received = header.clone();
    received.extend_from_slice(b"early-frame");
    let plan = request_plan(&header, &test_client()).unwrap();
    let (mut client, mut proxy_side) = tokio::io::duplex(1024);
    let error = proxy_request(
        &mut proxy_side,
        &runtime,
        &route,
        received,
        header_end,
        plan,
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("early WebSocket data"));
    let mut response = Vec::new();
    client.read_to_end(&mut response).await.unwrap();
    assert!(String::from_utf8(response)
        .unwrap()
        .starts_with("HTTP/1.1 400 Bad Request"));
}

/// Models Node's HTTP server with `httpAllowHalfOpen=false`: a FIN from the
/// client before the response is written aborts the request with no reply.
async fn half_close_intolerant_upstream(listener: TcpListener) {
    let (mut socket, _) = listener.accept().await.unwrap();
    let mut request = read_request_head(&mut socket).await.unwrap();
    let header_end = find_header_end(&request).unwrap();
    let mut body = request.split_off(header_end);
    let missing = 4 - body.len();
    let mut rest = vec![0_u8; missing];
    socket.read_exact(&mut rest).await.unwrap();
    body.extend_from_slice(&rest);
    assert_eq!(body, b"ping");
    assert!(String::from_utf8(request)
        .unwrap()
        .contains("Connection: close\r\n"));
    let mut probe = [0_u8; 1];
    if let Ok(read) = time::timeout(Duration::from_millis(200), socket.read(&mut probe)).await {
        assert_eq!(read.unwrap(), 0, "unexpected bytes after the request body");
        // EOF before responding: abort, exactly like Node does.
        return;
    }
    socket
        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello")
        .await
        .unwrap();
    socket.shutdown().await.unwrap();
}

#[tokio::test]
async fn upstreams_that_abort_on_half_close_still_return_a_full_response() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_port = listener.local_addr().unwrap().port();
    let upstream = tokio::spawn(half_close_intolerant_upstream(listener));
    let store = Arc::new(SnapshotStore::default());
    store
        .store(test_snapshot(1, 30_000, vec![test_route(upstream_port)]))
        .unwrap();
    let (mut client, proxy_side) = tokio::io::duplex(4096);
    let handler = tokio::spawn(crate::listener::handle_connection(
        proxy_side,
        "127.0.0.1:12345".parse().unwrap(),
        store,
        test_runtime(),
    ));
    client
        .write_all(b"POST /echo HTTP/1.1\r\nHost: app.example.test\r\nContent-Length: 4\r\n\r\npi")
        .await
        .unwrap();
    time::sleep(Duration::from_millis(20)).await;
    client.write_all(b"ng").await.unwrap();

    let mut response = Vec::new();
    time::timeout(Duration::from_secs(2), client.read_to_end(&mut response))
        .await
        .expect("proxy did not finish the response")
        .unwrap();
    let response = String::from_utf8(response).unwrap();
    assert!(response.starts_with("HTTP/1.1 200 OK\r\n"), "{response:?}");
    assert!(response.ends_with("\r\n\r\nhello"), "{response:?}");
    handler.await.unwrap().unwrap();
    upstream.await.unwrap();
}

#[tokio::test]
async fn a_slow_drip_request_body_hits_the_body_deadline() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_port = listener.local_addr().unwrap().port();
    let upstream = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut sink = Vec::new();
        let _ = socket.read_to_end(&mut sink).await;
    });
    let store = Arc::new(SnapshotStore::default());
    store
        .store(test_snapshot(1, 30_000, vec![test_route(upstream_port)]))
        .unwrap();
    let runtime = Arc::new({
        let mut runtime = Arc::try_unwrap(test_runtime()).ok().unwrap();
        runtime.limits.body_deadline = Duration::from_millis(100);
        runtime
    });
    let (mut client, proxy_side) = tokio::io::duplex(4096);
    let handler = tokio::spawn(crate::listener::handle_connection(
        proxy_side,
        "127.0.0.1:12345".parse().unwrap(),
        store,
        runtime,
    ));
    client
        .write_all(
            b"POST /upload HTTP/1.1\r\nHost: app.example.test\r\nContent-Length: 100\r\n\r\nab",
        )
        .await
        .unwrap();
    // Keep dripping well inside any per-read timeout; only a whole-body
    // budget can stop this.
    let drip = tokio::spawn(async move {
        for _ in 0..50 {
            time::sleep(Duration::from_millis(20)).await;
            if client.write_all(b"x").await.is_err() {
                break;
            }
        }
        client
    });

    let result = time::timeout(Duration::from_secs(2), handler)
        .await
        .expect("slow body was not cut off")
        .unwrap();
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("request body deadline exceeded"));
    let mut client = drip.await.unwrap();
    let mut response = Vec::new();
    client.read_to_end(&mut response).await.unwrap();
    assert!(String::from_utf8(response)
        .unwrap()
        .starts_with("HTTP/1.1 408 Request Timeout"));
    upstream.await.unwrap();
}

/// Accepts one request, returns everything it received up to `until`, then
/// answers 200 and closes.
async fn recording_upstream(listener: TcpListener, until: &'static [u8]) -> Vec<u8> {
    let (mut socket, _) = listener.accept().await.unwrap();
    let mut received = Vec::new();
    let mut buf = [0_u8; 1024];
    while !received.ends_with(until) {
        let n = socket.read(&mut buf).await.unwrap();
        assert!(n > 0, "upstream saw EOF before {until:?}: {received:?}");
        received.extend_from_slice(&buf[..n]);
    }
    socket
        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
        .await
        .unwrap();
    socket.shutdown().await.unwrap();
    received
}

async fn start_with_upstream(
    until: &'static [u8],
) -> (
    tokio::io::DuplexStream,
    tokio::task::JoinHandle<anyhow::Result<()>>,
    tokio::task::JoinHandle<Vec<u8>>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_port = listener.local_addr().unwrap().port();
    let upstream = tokio::spawn(recording_upstream(listener, until));
    let store = Arc::new(SnapshotStore::default());
    store
        .store(test_snapshot(1, 30_000, vec![test_route(upstream_port)]))
        .unwrap();
    let (client, proxy_side) = tokio::io::duplex(4096);
    let handler = tokio::spawn(handle_connection(
        proxy_side,
        "203.0.113.9:4000".parse().unwrap(),
        store,
        test_runtime(),
    ));
    (client, handler, upstream)
}

#[tokio::test]
async fn expect_100_continue_gets_an_interim_response_before_the_body() {
    let (mut client, handler, upstream) = start_with_upstream(b"\r\n\r\nping").await;
    client
        .write_all(b"POST /upload HTTP/1.1\r\nHost: app.example.test\r\nContent-Length: 4\r\nExpect: 100-continue\r\n\r\n")
        .await
        .unwrap();
    // Like curl: send nothing until the interim response arrives.
    let interim = time::timeout(Duration::from_secs(1), read_response_head(&mut client))
        .await
        .expect("no 100 Continue")
        .unwrap();
    assert_eq!(interim, b"HTTP/1.1 100 Continue\r\n\r\n");
    client.write_all(b"ping").await.unwrap();
    let mut response = Vec::new();
    client.read_to_end(&mut response).await.unwrap();
    assert!(String::from_utf8(response).unwrap().ends_with("\r\n\r\nok"));
    handler.await.unwrap().unwrap();
    let received = String::from_utf8(upstream.await.unwrap()).unwrap();
    assert!(
        !received.to_ascii_lowercase().contains("expect"),
        "{received}"
    );
    assert!(
        received.contains("X-Forwarded-For: 203.0.113.9\r\n"),
        "{received}"
    );
}

#[tokio::test]
async fn chunked_uploads_are_rechunked_to_the_upstream() {
    let (mut client, handler, upstream) = start_with_upstream(b"0\r\n\r\n").await;
    client
        .write_all(b"POST /git-receive-pack HTTP/1.1\r\nHost: app.example.test\r\nTransfer-Encoding: chunked\r\nX-Forwarded-For: 10.6.6.6\r\n\r\n5;x=y\r\nhello\r\n")
        .await
        .unwrap();
    time::sleep(Duration::from_millis(20)).await;
    client
        .write_all(b"6\r\n world\r\n0\r\nX-Trailer: t\r\n\r\n")
        .await
        .unwrap();
    let mut response = Vec::new();
    client.read_to_end(&mut response).await.unwrap();
    assert!(String::from_utf8(response)
        .unwrap()
        .starts_with("HTTP/1.1 200 OK"));
    handler.await.unwrap().unwrap();
    let received = String::from_utf8(upstream.await.unwrap()).unwrap();
    let (head, body) = received.split_once("\r\n\r\n").unwrap();
    assert!(head.contains("Transfer-Encoding: chunked"), "{head}");
    assert!(head.contains("X-Forwarded-For: 203.0.113.9"), "{head}");
    assert!(!head.contains("10.6.6.6"), "{head}");
    assert_eq!(body, "5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n");
}

#[tokio::test]
async fn malformed_chunked_upload_is_rejected_and_never_completed_upstream() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_port = listener.local_addr().unwrap().port();
    let upstream = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut received = Vec::new();
        let _ = socket.read_to_end(&mut received).await;
        received
    });
    let store = Arc::new(SnapshotStore::default());
    store
        .store(test_snapshot(1, 30_000, vec![test_route(upstream_port)]))
        .unwrap();
    let (mut client, proxy_side) = tokio::io::duplex(4096);
    let handler = tokio::spawn(handle_connection(
        proxy_side,
        "127.0.0.1:12345".parse().unwrap(),
        store,
        test_runtime(),
    ));
    // A smuggled second request hidden behind a bare-LF chunk size.
    client
        .write_all(b"POST / HTTP/1.1\r\nHost: app.example.test\r\nTransfer-Encoding: chunked\r\n\r\n0\n\r\nGET /admin HTTP/1.1\r\nHost: app.example.test\r\n\r\n")
        .await
        .unwrap();
    let mut response = Vec::new();
    client.read_to_end(&mut response).await.unwrap();
    assert!(String::from_utf8(response)
        .unwrap()
        .starts_with("HTTP/1.1 400 Bad Request"));
    assert!(handler.await.unwrap().is_err());
    let received = String::from_utf8(upstream.await.unwrap()).unwrap();
    assert!(!received.contains("/admin"), "{received}");
    assert!(!received.ends_with("0\r\n\r\n"), "{received}");
}
