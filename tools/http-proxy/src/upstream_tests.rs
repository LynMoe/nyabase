use super::*;
use crate::config::MAX_UPSTREAM_UPGRADE_HEADER_BYTES;
use crate::listener::handle_connection_with_fixed_request_deadline;
use crate::request::{read_request_head, request_plan, RequestMode};
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
            b"GET /socket HTTP/1.1\r\nHost: app.example.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
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
    let runtime = test_runtime();
    let (mut client, proxy_side) = tokio::io::duplex(4096);
    let handler_store = store.clone();
    let handler = tokio::spawn(handle_connection_with_fixed_request_deadline(
        proxy_side,
        "127.0.0.1:12345".parse().unwrap(),
        handler_store,
        runtime,
        Duration::from_millis(10),
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
        "WebSocket tunnel inherited the ordinary HTTP request deadline"
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
    let plan = request_plan(&header).unwrap();
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
