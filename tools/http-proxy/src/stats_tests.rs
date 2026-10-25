use super::*;
use crate::control::encode_status_report;
use crate::listener::handle_connection;
use crate::request::read_request_head;
use crate::snapshot::SnapshotStore;
use crate::test_support::*;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::time;

fn status_of(stats: &BindingStats, routed: &[&str], binding_id: &str) -> Option<BindingStatus> {
    let routed: HashSet<&str> = routed.iter().copied().collect();
    stats
        .report(&routed, Instant::now())
        .into_iter()
        .find(|status| status.binding_id == binding_id)
}

#[test]
fn routed_bindings_are_reported_even_before_their_first_request() {
    let stats = BindingStats::default();
    let status = status_of(&stats, &["binding-a"], "binding-a").unwrap();
    assert_eq!(
        status,
        BindingStatus {
            binding_id: "binding-a".into(),
            requests: 0,
            active_connections: 0,
            rx_bytes: 0,
            tx_bytes: 0,
        }
    );
}

#[test]
fn a_binding_that_left_the_snapshot_is_reported_until_its_last_relay_closes() {
    let stats = BindingStats::default();
    let counters = stats.counters("binding-a");
    counters.count_request();
    let relay = counters.open_relay();
    let status = status_of(&stats, &[], "binding-a").unwrap();
    assert_eq!(status.active_connections, 1);
    drop(relay);
    assert!(status_of(&stats, &[], "binding-a").is_none());
    // Still retained: a binding that comes back continues its totals.
    assert_eq!(stats.retained(), 1);
    counters.count_request();
    let status = status_of(&stats, &["binding-a"], "binding-a").unwrap();
    assert_eq!(status.requests, 2);
    assert_eq!(status.active_connections, 0);
}

#[test]
fn reports_and_retained_entries_are_bounded() {
    let stats = BindingStats::default();
    let ids: Vec<String> = (0..MAX_RETAINED_BINDINGS + 10)
        .map(|index| format!("binding-{index:05}"))
        .collect();
    let routed: HashSet<&str> = ids.iter().map(String::as_str).collect();
    assert_eq!(
        stats.report(&routed, Instant::now()).len(),
        MAX_REPORTED_BINDINGS
    );
    // Routed entries are never forgotten, whatever the bound.
    assert_eq!(stats.retained(), ids.len());

    // Once they leave the snapshot, the longest gone go first.
    let still_routed: HashSet<&str> = ids[ids.len() / 2..].iter().map(String::as_str).collect();
    stats.report(&still_routed, Instant::now());
    assert_eq!(stats.retained(), MAX_RETAINED_BINDINGS);
    let busy = stats.counters(&ids[ids.len() / 2]);
    let _relay = busy.open_relay();
    let later = Instant::now() + Duration::from_secs(1);
    let reported = stats.report(&HashSet::new(), later);
    assert_eq!(reported.len(), 1);
    assert_eq!(reported[0].binding_id, ids[ids.len() / 2]);
    assert_eq!(stats.retained(), MAX_RETAINED_BINDINGS);
}

#[tokio::test]
async fn metered_streams_count_both_directions() {
    let counters = Arc::new(BindingCounters::default());
    let (proxy_side, mut upstream) = tokio::io::duplex(1024);
    let mut metered = Metered::new(proxy_side, counters.clone());
    metered.write_all(b"request").await.unwrap();
    upstream.write_all(b"response!").await.unwrap();
    let mut buf = [0_u8; 9];
    metered.read_exact(&mut buf).await.unwrap();
    assert_eq!(counters.rx_bytes.load(Ordering::Relaxed), 7);
    assert_eq!(counters.tx_bytes.load(Ordering::Relaxed), 9);
}

#[tokio::test]
async fn a_proxied_exchange_counts_one_request_and_its_bytes() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_port = listener.local_addr().unwrap().port();
    let upstream = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let _ = read_request_head(&mut socket).await.unwrap();
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello")
            .await
            .unwrap();
        socket.shutdown().await.unwrap();
    });
    let store = Arc::new(SnapshotStore::default());
    store
        .store(test_snapshot(1, 30_000, vec![test_route(upstream_port)]))
        .unwrap();
    let runtime = test_runtime();
    let (mut client, proxy_side) = tokio::io::duplex(4096);
    let handler = tokio::spawn(handle_connection(
        proxy_side,
        "127.0.0.1:12345".parse().unwrap(),
        store.clone(),
        runtime.clone(),
    ));
    client
        .write_all(b"GET / HTTP/1.1\r\nHost: app.example.test\r\n\r\n")
        .await
        .unwrap();
    let mut response = Vec::new();
    time::timeout(Duration::from_secs(2), client.read_to_end(&mut response))
        .await
        .unwrap()
        .unwrap();
    handler.await.unwrap().unwrap();
    upstream.await.unwrap();

    let status = status_of(&runtime.binding_stats, &["binding-a"], "binding-a").unwrap();
    assert_eq!(status.requests, 1);
    assert_eq!(status.active_connections, 0);
    assert!(status.rx_bytes > 0, "request head was not counted");
    assert_eq!(status.tx_bytes, response.len() as u64);

    // An unknown host is not routed to any binding.
    let (mut client, proxy_side) = tokio::io::duplex(4096);
    let handler = tokio::spawn(handle_connection(
        proxy_side,
        "127.0.0.1:12345".parse().unwrap(),
        store.clone(),
        runtime.clone(),
    ));
    client
        .write_all(b"GET / HTTP/1.1\r\nHost: other.example.test\r\n\r\n")
        .await
        .unwrap();
    let mut response = Vec::new();
    client.read_to_end(&mut response).await.unwrap();
    handler.await.unwrap().unwrap();
    let status = status_of(&runtime.binding_stats, &["binding-a"], "binding-a").unwrap();
    assert_eq!(status.requests, 1);

    let report: serde_json::Value =
        serde_json::from_str(&encode_status_report(&runtime, &store).unwrap()).unwrap();
    assert_eq!(report["payload"]["instanceId"], "instance-test");
    assert_eq!(report["payload"]["bindings"][0]["bindingId"], "binding-a");
    assert_eq!(report["payload"]["bindings"][0]["requests"], 1);
    assert_eq!(report["payload"]["bindings"][0]["activeConnections"], 0);
}

#[tokio::test]
async fn an_open_websocket_tunnel_is_one_active_connection_until_it_closes() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_port = listener.local_addr().unwrap().port();
    let upstream = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let _ = read_request_head(&mut socket).await.unwrap();
        socket
            .write_all(
                b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n",
            )
            .await
            .unwrap();
        let mut frame = [0_u8; 4];
        socket.read_exact(&mut frame).await.unwrap();
        socket.write_all(b"pong").await.unwrap();
        let mut rest = Vec::new();
        socket.read_to_end(&mut rest).await.unwrap();
        socket.shutdown().await.unwrap();
    });
    let store = Arc::new(SnapshotStore::default());
    store
        .store(test_snapshot(1, 30_000, vec![test_route(upstream_port)]))
        .unwrap();
    let runtime = test_runtime();
    let (mut client, proxy_side) = tokio::io::duplex(4096);
    let handler = tokio::spawn(handle_connection(
        proxy_side,
        "127.0.0.1:12345".parse().unwrap(),
        store,
        runtime.clone(),
    ));
    client
        .write_all(b"GET /socket HTTP/1.1\r\nHost: app.example.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n")
        .await
        .unwrap();
    let head = crate::upstream::read_response_head(&mut client)
        .await
        .unwrap();
    assert!(head.starts_with(b"HTTP/1.1 101"));
    client.write_all(b"ping").await.unwrap();
    let mut pong = [0_u8; 4];
    client.read_exact(&mut pong).await.unwrap();

    let open = status_of(&runtime.binding_stats, &["binding-a"], "binding-a").unwrap();
    assert_eq!(open.requests, 1);
    assert_eq!(open.active_connections, 1);
    assert_eq!(open.tx_bytes, head.len() as u64 + 4);

    client.shutdown().await.unwrap();
    let mut rest = Vec::new();
    client.read_to_end(&mut rest).await.unwrap();
    time::timeout(Duration::from_secs(2), handler)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    upstream.await.unwrap();
    let closed = status_of(&runtime.binding_stats, &["binding-a"], "binding-a").unwrap();
    assert_eq!(closed.active_connections, 0);
    assert!(closed.rx_bytes > open.rx_bytes - 4);
}

#[test]
fn instance_ids_are_random_hex() {
    let first = new_instance_id();
    assert_eq!(first.len(), 32);
    assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
    assert_ne!(first, new_instance_id());
}
