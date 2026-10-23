use super::*;
use crate::protocol::{control_ack_message, ProxySnapshot};
use crate::snapshot::SnapshotStore;
use crate::test_support::*;
use proxy_common::clock::now_ms;
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::Error as WebSocketError;
use tokio_tungstenite::{accept_async, WebSocketStream};

#[test]
fn control_ack_is_a_complete_protocol_envelope() {
    let ack: serde_json::Value = serde_json::from_str(&control_ack_message(7)).unwrap();
    assert!(ack["ts"].as_u64().is_some());
    assert_eq!(ack["kind"], "ack");
    assert_eq!(ack["payload"]["generation"], 7);
}

#[tokio::test]
async fn a_stuck_control_writer_hits_a_hard_deadline() {
    let pending = std::future::pending::<std::result::Result<(), WebSocketError>>();
    let error = control_write_with_deadline(Duration::from_millis(5), pending)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("deadline exceeded"));
}

fn snapshot_with(generation: u64, stale_after_ms: u64, hostname: &str) -> ProxySnapshot {
    let mut route = test_route(8080);
    route.hostname = hostname.to_string();
    test_snapshot(generation, stale_after_ms, vec![route])
}

#[tokio::test]
async fn disconnect_holds_routes_for_at_most_the_hold_window() {
    let store = SnapshotStore::default();
    store
        .store(snapshot_with(5, 30_000, "app.example.test"))
        .unwrap();
    store.hold_after_disconnect(Duration::from_millis(80));
    assert!(store.authorize_route("app.example.test").is_some());

    // A failed reconnect re-applies the hold; it must not extend it.
    time::sleep(Duration::from_millis(40)).await;
    store.hold_after_disconnect(Duration::from_millis(80));
    time::sleep(Duration::from_millis(60)).await;
    assert!(store.authorize_route("app.example.test").is_none());
    assert!(store.load().is_none());
}

#[tokio::test]
async fn hold_never_outlives_the_snapshot_lease() {
    let store = SnapshotStore::default();
    store
        .store(snapshot_with(5, 60, "app.example.test"))
        .unwrap();
    store.hold_after_disconnect(Duration::from_secs(300));
    assert!(store.authorize_route("app.example.test").is_some());
    time::sleep(Duration::from_millis(90)).await;
    assert!(store.authorize_route("app.example.test").is_none());
}

#[test]
fn zero_hold_revokes_immediately() {
    let store = SnapshotStore::default();
    store
        .store(snapshot_with(5, 30_000, "app.example.test"))
        .unwrap();
    store.hold_after_disconnect(Duration::ZERO);
    assert!(store.load().is_none());
}

#[test]
fn a_new_epoch_accepts_a_restarted_backend_generation_and_replaces_the_held_routes() {
    let store = SnapshotStore::default();
    store
        .store(snapshot_with(500, 30_000, "app.example.test"))
        .unwrap();
    store.hold_after_disconnect(Duration::from_secs(300));
    // Still the same epoch: a lower generation is a rollback.
    assert!(store
        .store(snapshot_with(1, 30_000, "other.example.test"))
        .unwrap()
        .is_none());

    store.begin_control_epoch();
    assert!(store.authorize_route("app.example.test").is_some());
    let lease = store
        .store(snapshot_with(1, 30_000, "other.example.test"))
        .unwrap()
        .expect("first snapshot of a new epoch must install");
    assert_eq!(lease.generation, 1);
    assert!(store.authorize_route("app.example.test").is_none());
    assert!(store.authorize_route("other.example.test").is_some());
    // The new snapshot carries its own lease, not the shortened hold.
    let held_until = store.load().unwrap().deadline;
    assert!(held_until > std::time::Instant::now() + Duration::from_secs(20));
}

async fn wait_for(store: &SnapshotStore, hostname: &str, present: bool) {
    time::timeout(Duration::from_secs(5), async {
        while store.authorize_route(hostname).is_some() != present {
            time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{hostname} present={present} was never observed"));
}

fn snapshot_frame(generation: u64, hostname: &str) -> Message {
    let payload = serde_json::json!({
        "ts": now_ms(),
        "kind": "snapshot",
        "payload": {
            "generation": generation,
            "staleAfterMs": 30_000,
            "validUntil": now_ms() + 30_000,
            "routes": [{
                "bindingId": "binding-a",
                "hostname": hostname,
                "domainPoolId": "pool-a",
                "routedIp": "127.0.0.1",
                "targetPort": 8080,
                "ownerId": "user-a",
                "containerId": "container-a",
                "containerName": "app",
                "instanceName": "instance-a",
                "status": "running"
            }],
            "domainPools": []
        }
    });
    Message::Text(payload.to_string().into())
}

async fn accept_backend(listener: &TcpListener) -> WebSocketStream<TcpStream> {
    let (socket, _) = listener.accept().await.unwrap();
    accept_async(socket).await.unwrap()
}

async fn read_ack(ws: &mut WebSocketStream<TcpStream>) -> u64 {
    loop {
        let message = ws.next().await.unwrap().unwrap();
        let Ok(text) = message.to_text() else {
            continue;
        };
        let value: serde_json::Value = serde_json::from_str(text).unwrap();
        if value["kind"] == "ack" {
            return value["payload"]["generation"].as_u64().unwrap();
        }
    }
}

fn loop_config(backend: std::net::SocketAddr, control_hold: Duration) -> Config {
    Config {
        backend_ws: format!("ws://{backend}/ws/http-proxy"),
        backend_tls: None,
        token: "t".repeat(32),
        http_listen: "127.0.0.1:0".into(),
        https_listen: None,
        max_connections: 8,
        max_connections_per_ip: 8,
        max_connections_per_ipv6_48: 8,
        max_pending_connections: 8,
        max_connections_per_container: 8,
        max_connections_per_ip_per_container: 8,
        max_connections_per_owner: 8,
        limits: Default::default(),
        reconnect_delay: Duration::from_millis(20),
        status_interval: Duration::from_secs(60),
        control_hold,
        control_liveness: Default::default(),
    }
}

#[tokio::test]
async fn control_loop_keeps_sites_up_across_a_backend_restart() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let config = loop_config(listener.local_addr().unwrap(), Duration::from_secs(300));
    let store = Arc::new(SnapshotStore::default());
    let (_status_tx, status_rx) = mpsc::channel(4);
    let proxy = tokio::spawn(control_loop(
        config,
        store.clone(),
        test_runtime(),
        status_rx,
    ));

    let mut first = accept_backend(&listener).await;
    first
        .send(snapshot_frame(500, "app.example.test"))
        .await
        .unwrap();
    assert_eq!(read_ack(&mut first).await, 500);
    wait_for(&store, "app.example.test", true).await;

    // Backend goes away; the proxy reconnects several times while it is down.
    drop(first);
    time::sleep(Duration::from_millis(100)).await;
    assert!(store.authorize_route("app.example.test").is_some());

    // The restarted Backend starts its generations over.
    let mut second = accept_backend(&listener).await;
    assert!(store.authorize_route("app.example.test").is_some());
    second
        .send(snapshot_frame(1, "other.example.test"))
        .await
        .unwrap();
    assert_eq!(read_ack(&mut second).await, 1);
    wait_for(&store, "other.example.test", true).await;
    assert!(store.authorize_route("app.example.test").is_none());
    proxy.abort();
}

#[tokio::test]
async fn control_loop_drops_held_sites_when_the_hold_expires() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let config = loop_config(listener.local_addr().unwrap(), Duration::from_millis(150));
    let store = Arc::new(SnapshotStore::default());
    let (_status_tx, status_rx) = mpsc::channel(4);
    let proxy = tokio::spawn(control_loop(
        config,
        store.clone(),
        test_runtime(),
        status_rx,
    ));

    let mut first = accept_backend(&listener).await;
    first
        .send(snapshot_frame(1, "app.example.test"))
        .await
        .unwrap();
    assert_eq!(read_ack(&mut first).await, 1);
    drop(first);
    time::sleep(Duration::from_millis(60)).await;
    assert!(store.authorize_route("app.example.test").is_some());
    wait_for(&store, "app.example.test", false).await;
    proxy.abort();
}

fn fast_liveness() -> proxy_common::control_link::ControlLiveness {
    proxy_common::control_link::ControlLiveness {
        connect_deadline: Duration::from_millis(500),
        ping_interval: Duration::from_millis(20),
        read_deadline: Duration::from_millis(80),
    }
}

#[tokio::test]
async fn a_silent_backend_is_dropped_and_reconnected_but_a_live_one_is_kept() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut config = loop_config(listener.local_addr().unwrap(), Duration::from_secs(300));
    config.control_liveness = fast_liveness();
    let store = Arc::new(SnapshotStore::default());
    let (_status_tx, status_rx) = mpsc::channel(4);
    let proxy = tokio::spawn(control_loop(
        config,
        store.clone(),
        test_runtime(),
        status_rx,
    ));

    // A Backend that answers pings (by reading) keeps the link well past the
    // read deadline.
    let mut live = accept_backend(&listener).await;
    live.send(snapshot_frame(1, "app.example.test"))
        .await
        .unwrap();
    assert_eq!(read_ack(&mut live).await, 1);
    let mut pings = 0;
    let kept = time::timeout(Duration::from_millis(300), async {
        loop {
            if let Message::Ping(_) = live.next().await.unwrap().unwrap() {
                pings += 1;
            }
        }
    })
    .await;
    assert!(kept.is_err(), "the proxy closed a live control link");
    assert!(pings >= 3, "only {pings} pings in 300 ms");
    assert!(
        time::timeout(Duration::from_millis(1), listener.accept())
            .await
            .is_err(),
        "the proxy reconnected while the link was alive"
    );

    // The same Backend now stops reading: no pongs, no frames. The proxy
    // gives up on it and reconnects, keeping the held routes meanwhile.
    let mut second = time::timeout(Duration::from_secs(2), accept_backend(&listener))
        .await
        .expect("the proxy did not drop a silent control link");
    assert!(store.authorize_route("app.example.test").is_some());
    second
        .send(snapshot_frame(1, "other.example.test"))
        .await
        .unwrap();
    assert_eq!(read_ack(&mut second).await, 1);
    drop(live);
    proxy.abort();
}
