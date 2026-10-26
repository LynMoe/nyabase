use super::*;
use crate::bridge::spawn_connection_task;
use crate::config::ProxyConfig;
use crate::session::resolve_owned_route;
use crate::snapshot::{parse_authorized_key, RoutingSnapshot};
use crate::test_support::*;
use futures_util::future::Abortable;
use pretty_assertions::assert_eq;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[test]
fn child_task_registry_is_hard_bounded_and_releases_reservations() {
    let (connection, _main_registration) =
        ConnectionState::new(1, "127.0.0.1:2200".parse().unwrap());
    let connection = Arc::new(connection);
    let mut permits = (0..MAX_CHILD_TASKS_PER_CONNECTION)
        .map(|_| {
            connection
                .try_reserve_child_task()
                .expect("reservation below the hard limit")
        })
        .collect::<Vec<_>>();

    assert!(connection.try_reserve_child_task().is_none());
    permits.pop();
    assert!(connection.try_reserve_child_task().is_some());
    drop(permits);
    assert!(lock(&connection.child_abort_handles).is_empty());
}

#[tokio::test]
async fn unregistering_a_connection_aborts_and_cleans_all_child_tasks() {
    let config = ProxyConfig {
        backend_ws: "ws://backend.invalid".to_string(),
        backend_tls: None,
        token: "a".repeat(32),
        listen: "127.0.0.1:2222".to_string(),
        max_connections: 8,
        max_connections_per_ip: 8,
        max_connections_per_ipv6_48: 8,
        max_preauth_connections: 8,
        auth_timeout: Duration::from_secs(30),
        reconnect_delay: Duration::from_secs(1),
        route_connect_timeout: Duration::from_secs(1),
        status_interval: Duration::from_secs(1),
        control_hold: Duration::from_secs(300),
        control_liveness: Default::default(),
    };
    let runtime = ProxyRuntime::new(&config);
    let (connection, _main_registration) =
        runtime.register_connection("127.0.0.1:2205".parse().unwrap());
    connection
        .try_reserve_child_task()
        .expect("child reservation")
        .spawn(std::future::pending());
    assert_eq!(lock(&connection.child_abort_handles).len(), 1);

    runtime.unregister_connection(&connection.id);

    assert!(connection.revoked.load(Ordering::Acquire));
    assert!(lock(&connection.child_abort_handles).is_empty());
    tokio::task::yield_now().await;
}

#[test]
fn authenticated_connection_revalidation_is_semantic_and_fail_closed() {
    let public_key = parse_authorized_key(ALICE_KEY).expect("expected public key");
    let initial = fixture_snapshot();
    let route = resolve_owned_route(&initial, "alice.solo").expect("expected route");
    let (connection, _abort_registration) =
        ConnectionState::new(1, "127.0.0.1:2222".parse().unwrap());
    connection.set_authenticated(
        "alice.solo",
        &public_key,
        &route.user_id,
        &route.username,
        Some(&route),
    );
    assert!(connection.authorization_matches(Some(&initial)));

    // A generation-only refresh with the same authorization tuple keeps
    // the session, avoiding periodic full-report disconnect storms.
    let same_authorization = RoutingSnapshot::from_snapshot(fixture_proxy_snapshot(8)).unwrap();
    assert!(connection.authorization_matches(Some(&same_authorization)));

    let mut rotated = fixture_proxy_snapshot(9);
    rotated
        .routes
        .iter_mut()
        .find(|route| route.container_id == "container-c")
        .unwrap()
        .routed_ip = Some("10.0.0.99".to_string());
    let rotated = RoutingSnapshot::from_snapshot(rotated).unwrap();
    assert!(!connection.authorization_matches(Some(&rotated)));

    let mut public_key_removed = fixture_proxy_snapshot(10);
    public_key_removed.users[0].public_keys.clear();
    assert!(!connection.authorization_matches(Some(
        &RoutingSnapshot::from_snapshot(public_key_removed).unwrap(),
    )));

    let mut user_disabled = fixture_proxy_snapshot(11);
    user_disabled.users[0].status = "disabled".to_string();
    assert!(!connection.authorization_matches(Some(
        &RoutingSnapshot::from_snapshot(user_disabled).unwrap(),
    )));

    let mut image_disabled = fixture_proxy_snapshot(12);
    image_disabled
        .images
        .iter_mut()
        .find(|image| image.id == "image-a")
        .unwrap()
        .ssh_enabled = false;
    assert!(!connection.authorization_matches(Some(
        &RoutingSnapshot::from_snapshot(image_disabled).unwrap(),
    )));

    let mut route_removed = fixture_proxy_snapshot(13);
    route_removed
        .routes
        .retain(|route| route.container_id != "container-c");
    assert!(!connection.authorization_matches(Some(
        &RoutingSnapshot::from_snapshot(route_removed).unwrap(),
    )));
    assert!(!connection.authorization_matches(None));

    let mut stale = fixture_snapshot();
    stale.deadline = Instant::now() - Duration::from_millis(1);
    assert!(!stale.is_fresh());
    assert!(connection.authorization_matches(Some(&stale)));
}

#[tokio::test]
async fn revoked_connections_abort_directly_without_protocol_backpressure() {
    let config = ProxyConfig {
        backend_ws: "ws://backend.invalid".to_string(),
        backend_tls: None,
        token: "test".to_string(),
        listen: "127.0.0.1:2222".to_string(),
        max_connections: 8,
        max_connections_per_ip: 8,
        max_connections_per_ipv6_48: 8,
        max_preauth_connections: 8,
        auth_timeout: Duration::from_secs(30),
        reconnect_delay: Duration::from_secs(1),
        route_connect_timeout: Duration::from_secs(1),
        status_interval: Duration::from_secs(1),
        control_hold: Duration::from_secs(300),
        control_liveness: Default::default(),
    };
    let runtime = ProxyRuntime::new(&config);
    let snapshot = fixture_snapshot();
    let public_key = parse_authorized_key(ALICE_KEY).expect("expected public key");
    let route = resolve_owned_route(&snapshot, "alice.solo").expect("expected route");

    let (first, first_registration) =
        runtime.register_connection("127.0.0.1:2201".parse().unwrap());
    first.set_authenticated(
        "alice.solo",
        &public_key,
        &route.user_id,
        &route.username,
        Some(&route),
    );
    let (second, second_registration) =
        runtime.register_connection("127.0.0.1:2202".parse().unwrap());
    second.set_authenticated(
        "alice.solo",
        &public_key,
        &route.user_id,
        &route.username,
        Some(&route),
    );

    // These futures model connection tasks whose graceful protocol send
    // would never finish. Revocation cancels their owning tasks directly.
    let first_task = tokio::spawn(Abortable::new(
        std::future::pending::<()>(),
        first_registration,
    ));
    let second_task = tokio::spawn(Abortable::new(
        std::future::pending::<()>(),
        second_registration,
    ));
    struct DropFlag(Arc<AtomicBool>);
    impl Drop for DropFlag {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Release);
        }
    }
    let child_dropped = Arc::new(AtomicBool::new(false));
    let child_drop_flag = child_dropped.clone();
    spawn_connection_task(first.clone(), async move {
        let _drop_flag = DropFlag(child_drop_flag);
        std::future::pending::<()>().await;
    });
    tokio::task::yield_now().await;

    let disconnected = tokio::time::timeout(
        Duration::from_millis(100),
        runtime.disconnect_invalid(None, "authorization revoked"),
    )
    .await
    .expect("revocation must not wait on a client");
    assert_eq!(disconnected, 2);
    assert_eq!(
        runtime.disconnect_invalid(None, "duplicate revoke").await,
        0
    );

    assert!(tokio::time::timeout(Duration::from_millis(100), first_task)
        .await
        .expect("first task must abort")
        .expect("first join must succeed")
        .is_err());
    assert!(
        tokio::time::timeout(Duration::from_millis(100), second_task)
            .await
            .expect("second task must abort")
            .expect("second join must succeed")
            .is_err()
    );
    tokio::time::timeout(Duration::from_millis(100), async {
        while !child_dropped.load(Ordering::Acquire) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("revocation must abort spawned channel tasks");
}

#[test]
fn status_report_stays_under_the_control_frame_limit_at_full_capacity() {
    let runtime = ProxyRuntime::new(&crate::test_support::test_config());
    let public_key = parse_authorized_key(ALICE_KEY).expect("expected public key");
    // Worst case per entry: the longest accepted login made only of bytes
    // that JSON escapes, plus a full route.
    let login = "\"".repeat(crate::session::MAX_SSH_LOGIN_BYTES);
    let snapshot = fixture_snapshot();
    let route = resolve_owned_route(&snapshot, "alice.solo").expect("expected route");
    for port in 0..MAX_STATUS_CONNECTION_DETAILS + 10 {
        let peer = format!("[2001:db8:ffff:ffff:ffff:ffff:ffff:ffff]:{}", 1000 + port);
        let (connection, _registration) = runtime.register_connection(peer.parse().unwrap());
        connection.set_authenticated(
            &login,
            &public_key,
            &route.user_id,
            &route.username,
            Some(&route),
        );
    }

    let report = runtime.status_report();
    assert_eq!(
        report.active_connections,
        MAX_STATUS_CONNECTION_DETAILS + 10
    );
    assert!(report.connections.len() <= MAX_STATUS_CONNECTION_DETAILS);
    assert!(report.omitted_connections >= 10);
    assert_eq!(
        report.connections.len() + report.omitted_connections,
        report.active_connections
    );
    let frame = crate::control::encode_status_frame(&runtime).unwrap();
    assert!(frame.len() <= crate::control::BACKEND_CONTROL_MAX_FRAME_BYTES);
}

#[test]
fn bounded_status_report_keeps_the_oldest_details_that_fit() {
    let runtime = ProxyRuntime::new(&crate::test_support::test_config());
    for port in 0..8 {
        runtime.register_connection(format!("127.0.0.1:{}", 3000 + port).parse().unwrap());
    }
    let full = runtime.status_report();
    assert_eq!(full.omitted_connections, 0);
    let entry = serde_json::to_vec(&full.connections[0]).unwrap().len() + 1;

    let bounded = runtime.status_report().bounded(1024, entry * 3);
    assert_eq!(bounded.connections.len(), 3);
    assert_eq!(bounded.omitted_connections, 5);
    assert_eq!(bounded.active_connections, 8);
    assert_eq!(bounded.connections[0].id, full.connections[0].id);

    let by_count = runtime.status_report().bounded(2, usize::MAX);
    assert_eq!(by_count.connections.len(), 2);
    assert_eq!(by_count.omitted_connections, 6);
}

#[tokio::test]
async fn every_bridged_route_is_revalidated_and_closed_on_its_own() {
    let runtime = ProxyRuntime::new(&crate::test_support::test_config());
    let snapshot = fixture_snapshot();
    let public_key = parse_authorized_key(ALICE_KEY).expect("expected public key");
    let (connection, registration) = runtime.register_connection("127.0.0.1:2501".parse().unwrap());
    // A non-jump login: nothing is pinned, every route comes from a bridge.
    connection.set_authenticated("alice", &public_key, "user-a", "alice", None);
    let connection_task = tokio::spawn(Abortable::new(std::future::pending::<()>(), registration));

    struct DropFlag(Arc<AtomicBool>);
    impl Drop for DropFlag {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Release);
        }
    }
    let mut closed = Vec::new();
    for ip in ["10.0.0.2", "10.0.0.4"] {
        let route = snapshot
            .resolve_owned_route_for_user_ip("user-a", ip)
            .expect("alice owns this route");
        let permit = connection.try_reserve_child_task().expect("child slot");
        permit.bind_route(&route);
        connection.set_display_route(&route);
        let flag = Arc::new(AtomicBool::new(false));
        let guard = DropFlag(flag.clone());
        let open_channel = crate::bridge::OpenChannel::untracked(connection.clone());
        permit.spawn(async move {
            let _guard = guard;
            let _open_channel = open_channel;
            std::future::pending::<()>().await;
        });
        closed.push(flag);
    }
    tokio::task::yield_now().await;
    assert_eq!(lock(&connection.bridge_routes).len(), 2);
    assert_eq!(connection.channels.load(Ordering::Relaxed), 2);

    // The first bridge's container route disappears; the newer one (which is
    // also the displayed route) stays valid.
    let mut first_removed = crate::test_support::fixture_proxy_snapshot(8);
    first_removed
        .routes
        .retain(|route| route.container_id != "container-a");
    let first_removed = RoutingSnapshot::from_snapshot(first_removed).unwrap();
    assert!(connection.authorization_matches(Some(&first_removed)));
    assert_eq!(
        runtime
            .disconnect_invalid(Some(&first_removed), "route revoked")
            .await,
        0
    );
    tokio::time::timeout(Duration::from_millis(200), async {
        while !closed[0].load(Ordering::Acquire) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the revoked bridge must be closed");
    assert!(!closed[1].load(Ordering::Acquire));
    assert!(!connection.revoked.load(Ordering::Acquire));
    assert_eq!(lock(&connection.bridge_routes).len(), 1);
    assert_eq!(connection.channels.load(Ordering::Relaxed), 1);
    assert_eq!(lock(&connection.child_abort_handles).len(), 1);

    connection_task.abort();
    let _ = connection_task.await;
}
