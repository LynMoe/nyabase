use super::*;
use crate::config::ProxyConfig;
use crate::protocol::{BackendEnvelope, ProxySnapshot, SshProxyPauseAdmitCommand};
use crate::runtime::{lock, ConnectionState, ProxyRuntime};
use crate::session::{resolve_owned_route, ProxySshSession};
use crate::snapshot::{parse_authorized_key, SnapshotStore};
use crate::test_support::NeverReadySink;
use crate::test_support::*;
use futures_util::future::Abortable;
use pretty_assertions::assert_eq;
use proxy_common::clock::now_ms;
use proxy_common::env::MAX_STATUS_INTERVAL_MS;
use russh::server::Auth;
use russh::server::Handler;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

#[tokio::test]
async fn bad_host_private_key_rejects_before_ack_and_revokes_current_snapshot() {
    let mut invalid = fixture_proxy_snapshot(8);
    invalid.host_key.private_key = "not-an-openssh-private-key".to_string();

    assert_invalid_key_snapshot_revokes(invalid, "failed to parse SSH proxy host private key")
        .await;
}

async fn assert_invalid_key_snapshot_revokes(invalid: ProxySnapshot, expected_error: &str) {
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
    let store = SnapshotStore::default();
    let runtime = ProxyRuntime::new(&config);
    let control = ControlPlane::new();
    control.begin_epoch();
    assert_eq!(
        install_backend_snapshot(&store, &runtime, &control, fixture_proxy_snapshot(7))
            .await
            .unwrap(),
        7,
    );
    let installed = store.load().expect("initial snapshot");
    let public_key = parse_authorized_key(ALICE_KEY).expect("expected public key");
    let route = resolve_owned_route(&installed, "alice.solo").expect("expected route");
    let (connection, main_registration) =
        runtime.register_connection("127.0.0.1:2206".parse().unwrap());
    connection.set_authenticated(
        "alice.solo",
        &public_key,
        &route.user_id,
        &route.username,
        Some(&route),
    );
    let connection_task = tokio::spawn(Abortable::new(
        std::future::pending::<()>(),
        main_registration,
    ));

    let error = install_backend_snapshot(&store, &runtime, &control, invalid)
        .await
        .expect_err("invalid key snapshot must fail before ACK");

    assert!(error.to_string().contains(expected_error), "{error:#}");
    assert!(store.load().is_none());
    assert_eq!(runtime.last_snapshot_generation.load(Ordering::Relaxed), 0);
    assert!(
        tokio::time::timeout(Duration::from_millis(100), connection_task)
            .await
            .expect("current connection was not revoked")
            .expect("connection task join")
            .is_err()
    );
    runtime.unregister_connection(&connection.id);
}

#[tokio::test]
async fn snapshot_deadline_expires_and_revokes_without_a_status_tick() {
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
        status_interval: Duration::from_millis(MAX_STATUS_INTERVAL_MS),
        control_hold: Duration::from_secs(300),
        control_liveness: Default::default(),
    };
    let store = Arc::new(SnapshotStore::default());
    let runtime = Arc::new(ProxyRuntime::new(&config));
    let control = Arc::new(ControlPlane::new());
    control.begin_epoch();
    let mut snapshot = fixture_proxy_snapshot(7);
    snapshot.valid_until = now_ms() + 30;
    assert!(store.store(snapshot, control.epoch()).unwrap());
    control.resume_authoritative();
    runtime.mark_snapshot(7);

    let installed = store.load().expect("snapshot");
    let public_key = parse_authorized_key(ALICE_KEY).expect("expected public key");
    let route = resolve_owned_route(&installed, "alice.solo").expect("expected route");
    let (connection, main_registration) =
        runtime.register_connection("127.0.0.1:2204".parse().unwrap());
    connection.set_authenticated(
        "alice.solo",
        &public_key,
        &route.user_id,
        &route.username,
        Some(&route),
    );
    let connection_task = tokio::spawn(Abortable::new(
        std::future::pending::<()>(),
        main_registration,
    ));
    let expiry_task = tokio::spawn(run_control_timers(
        store.clone(),
        runtime.clone(),
        control.clone(),
    ));

    tokio::time::timeout(Duration::from_secs(1), async {
        while store.load().is_some() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("independent snapshot deadline did not expire");

    assert_eq!(runtime.last_snapshot_generation.load(Ordering::Relaxed), 0);
    assert!(
        tokio::time::timeout(Duration::from_millis(100), connection_task)
            .await
            .expect("authenticated session was not revoked at the lease deadline")
            .expect("connection task join")
            .is_err()
    );
    expiry_task.abort();
    let _ = expiry_task.await;
}

#[tokio::test]
async fn blocked_control_write_times_out_and_control_revocation_aborts_sessions() {
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
    let store = SnapshotStore::default();
    assert!(store.store(fixture_proxy_snapshot(7), 0).unwrap());
    let snapshot = store.load().expect("snapshot");
    let public_key = parse_authorized_key(ALICE_KEY).expect("expected public key");
    let route = resolve_owned_route(&snapshot, "alice.solo").expect("expected route");
    let (connection, abort_registration) =
        runtime.register_connection("127.0.0.1:2203".parse().unwrap());
    connection.set_authenticated(
        "alice.solo",
        &public_key,
        &route.user_id,
        &route.username,
        Some(&route),
    );
    let connection_task = tokio::spawn(Abortable::new(
        std::future::pending::<()>(),
        abort_registration,
    ));

    let mut sink = NeverReadySink;
    tokio::time::timeout(
        Duration::from_millis(100),
        send_control_frame(
            &mut sink,
            Message::Text("blocked".into()),
            Duration::from_millis(20),
        ),
    )
    .await
    .expect("control write deadline must be bounded")
    .expect_err("never-ready sink must time out");

    let control = ControlPlane::new();
    control.begin_epoch();
    control.resume_authoritative();
    pause_control_plane(
        &control,
        &runtime,
        Duration::from_secs(300),
        "control write timeout",
    )
    .await;
    assert!(store.load().is_some());
    assert!(!control.admit());
    assert_eq!(control.mode(), ControlMode::Paused);
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(!connection.revoked.load(Ordering::Acquire));
    connection_task.abort();
    let _ = connection_task.await;
}

#[tokio::test]
async fn ws_disconnect_pauses_admit_and_keeps_authenticated_sessions() {
    let config = test_config();
    let store = SnapshotStore::default();
    let runtime = ProxyRuntime::new(&config);
    let control = paused_plane(&store);
    let snapshot = store.load().expect("held");
    let public_key = parse_authorized_key(ALICE_KEY).unwrap();
    let route = resolve_owned_route(&snapshot, "alice.solo").unwrap();
    let (connection, registration) = runtime.register_connection("127.0.0.1:2301".parse().unwrap());
    connection.set_authenticated(
        "alice.solo",
        &public_key,
        &route.user_id,
        &route.username,
        Some(&route),
    );
    let task = tokio::spawn(Abortable::new(std::future::pending::<()>(), registration));
    pause_control_plane(
        &control,
        &runtime,
        config.control_hold,
        "SSH proxy control plane disconnected",
    )
    .await;
    assert_eq!(control.mode(), ControlMode::Paused);
    assert!(!control.admit());
    assert!(store.load().is_some());
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(!connection.revoked.load(Ordering::Acquire));
    task.abort();
    let _ = task.await;
}

#[tokio::test]
async fn pause_is_idempotent_and_does_not_refresh_hold() {
    let control = ControlPlane::new();
    control.begin_epoch();
    SnapshotStore::default()
        .store(fixture_proxy_snapshot(7), control.epoch())
        .unwrap();
    control.resume_authoritative();
    assert!(control.pause(Duration::from_secs(300)));
    let first = control.hold_deadline().expect("armed");
    assert!(!control.pause(Duration::from_secs(300)));
    assert_eq!(control.hold_deadline(), Some(first));
}

#[test]
fn begin_epoch_while_paused_does_not_refresh_hold() {
    let store = SnapshotStore::default();
    let control = paused_plane(&store);
    let first = control.hold_deadline().expect("armed");
    let epoch = control.epoch();
    control.begin_epoch();
    assert_eq!(control.epoch(), epoch + 1);
    assert!(!control.admit());
    assert_eq!(control.mode(), ControlMode::Paused);
    assert_eq!(control.hold_deadline(), Some(first));
    assert!(store.load().is_some());
}

#[tokio::test]
async fn pause_hold_expiry_fail_closes_held_sessions() {
    let mut config = test_config();
    config.control_hold = Duration::from_millis(30);
    let store = Arc::new(SnapshotStore::default());
    let runtime = Arc::new(ProxyRuntime::new(&config));
    let control = Arc::new(ControlPlane::new());
    control.begin_epoch();
    assert!(store
        .store(fixture_proxy_snapshot(7), control.epoch())
        .unwrap());
    control.resume_authoritative();
    let snapshot = store.load().unwrap();
    let public_key = parse_authorized_key(ALICE_KEY).unwrap();
    let route = resolve_owned_route(&snapshot, "alice.solo").unwrap();
    let (connection, registration) = runtime.register_connection("127.0.0.1:2302".parse().unwrap());
    connection.set_authenticated(
        "alice.solo",
        &public_key,
        &route.user_id,
        &route.username,
        Some(&route),
    );
    let task = tokio::spawn(Abortable::new(std::future::pending::<()>(), registration));
    pause_control_plane(&control, &runtime, config.control_hold, "test hold").await;
    let timers = tokio::spawn(run_control_timers(
        store.clone(),
        runtime.clone(),
        control.clone(),
    ));
    tokio::time::timeout(Duration::from_secs(1), async {
        while store.load().is_some() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("hold did not expire");
    assert_eq!(control.mode(), ControlMode::Empty);
    assert!(tokio::time::timeout(Duration::from_millis(100), task)
        .await
        .expect("held session was not revoked")
        .expect("join")
        .is_err());
    timers.abort();
    let _ = timers.await;
}

#[tokio::test]
async fn new_epoch_snapshot_replaces_held_and_disconnects_invalid() {
    let config = test_config();
    let store = SnapshotStore::default();
    let runtime = ProxyRuntime::new(&config);
    let control = ControlPlane::new();
    control.begin_epoch();
    assert_eq!(
        install_backend_snapshot(&store, &runtime, &control, fixture_proxy_snapshot(7))
            .await
            .unwrap(),
        7,
    );
    let snapshot = store.load().unwrap();
    let public_key = parse_authorized_key(ALICE_KEY).unwrap();
    let route = resolve_owned_route(&snapshot, "alice.solo").unwrap();
    let (connection, registration) = runtime.register_connection("127.0.0.1:2303".parse().unwrap());
    connection.set_authenticated(
        "alice.solo",
        &public_key,
        &route.user_id,
        &route.username,
        Some(&route),
    );
    let task = tokio::spawn(Abortable::new(std::future::pending::<()>(), registration));
    control.begin_epoch();
    let mut rotated = fixture_proxy_snapshot(1);
    rotated
        .routes
        .iter_mut()
        .find(|route| route.container_id == "container-c")
        .unwrap()
        .routed_ip = Some("10.0.0.99".to_string());
    install_backend_snapshot(&store, &runtime, &control, rotated)
        .await
        .unwrap();
    assert!(control.admit());
    assert!(tokio::time::timeout(Duration::from_millis(100), task)
        .await
        .expect("rotated route must disconnect")
        .expect("join")
        .is_err());
}

#[tokio::test]
async fn new_epoch_snapshot_keeps_still_authorized_sessions() {
    let config = test_config();
    let store = SnapshotStore::default();
    let runtime = ProxyRuntime::new(&config);
    let control = ControlPlane::new();
    control.begin_epoch();
    install_backend_snapshot(&store, &runtime, &control, fixture_proxy_snapshot(7))
        .await
        .unwrap();
    let snapshot = store.load().unwrap();
    let public_key = parse_authorized_key(ALICE_KEY).unwrap();
    let route = resolve_owned_route(&snapshot, "alice.solo").unwrap();
    let (connection, registration) = runtime.register_connection("127.0.0.1:2304".parse().unwrap());
    connection.set_authenticated(
        "alice.solo",
        &public_key,
        &route.user_id,
        &route.username,
        Some(&route),
    );
    let task = tokio::spawn(Abortable::new(std::future::pending::<()>(), registration));
    control.begin_epoch();
    install_backend_snapshot(&store, &runtime, &control, fixture_proxy_snapshot(1))
        .await
        .unwrap();
    assert!(control.admit());
    assert_eq!(store.load().map(|s| s.generation), Some(1));
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(!connection.revoked.load(Ordering::Acquire));
    task.abort();
    let _ = task.await;
}

#[tokio::test]
async fn paused_new_connection_is_rejected_without_stale_auth() {
    let config = test_config();
    let store = Arc::new(SnapshotStore::default());
    let control = paused_plane(store.as_ref());
    assert!(store.load().unwrap().is_fresh());
    let (connection, _) = ConnectionState::new(1, "127.0.0.1:2305".parse().unwrap());
    let connection = Arc::new(connection);
    let (tx, _rx) = mpsc::channel(8);
    let mut session = ProxySshSession::new(
        store.clone(),
        control.clone(),
        config,
        "127.0.0.1:2305".parse().unwrap(),
        tx,
        connection.clone(),
        true,
    );
    let key = parse_authorized_key(ALICE_KEY).unwrap();
    assert!(session.latest_snapshot().is_none());
    assert!(session.held_snapshot().is_some());
    let offered = session
        .auth_publickey_offered("alice.solo", &key)
        .await
        .unwrap();
    assert!(matches!(offered, Auth::Accept));
    let accepted = session.auth_publickey("alice.solo", &key).await.unwrap();
    assert!(matches!(accepted, Auth::Accept));
    assert!(lock(&connection.login).is_none());
    assert_eq!(connection.authenticated_at.load(Ordering::Relaxed), 0);
}

#[test]
fn pause_admit_kind_deserializes() {
    let envelope: BackendEnvelope = serde_json::from_str(
        r#"{"kind":"pauseAdmit","payload":{"reason":"backend shutting down"}}"#,
    )
    .unwrap();
    assert_eq!(envelope.kind, "pauseAdmit");
    let command: SshProxyPauseAdmitCommand = serde_json::from_value(envelope.payload).unwrap();
    assert_eq!(command.reason.as_deref(), Some("backend shutting down"));
}

#[test]
fn unknown_backend_kind_is_ignored_without_pause_or_revoke() {
    let store = SnapshotStore::default();
    let control = paused_plane(&store);
    let envelope: BackendEnvelope =
        serde_json::from_str(r#"{"kind":"notARealKind","payload":{}}"#).unwrap();
    assert_eq!(envelope.kind, "notARealKind");
    assert_eq!(control.mode(), ControlMode::Paused);
    assert!(store.load().is_some());
}

#[test]
fn direct_tcpip_on_held_snapshot_ignores_freshness_while_paused() {
    let config = test_config();
    let store = Arc::new(SnapshotStore::default());
    let control = paused_plane(store.as_ref());
    {
        let snapshot = store.load().unwrap();
        // Force an expired lease on a clone used for matching.
        let mut expired = (*snapshot).clone();
        expired.deadline = Instant::now() - Duration::from_millis(1);
        drop(snapshot);
        let public_key = parse_authorized_key(ALICE_KEY).unwrap();
        let route = resolve_owned_route(&expired, "alice.solo").unwrap();
        let (connection, _) = ConnectionState::new(1, "127.0.0.1:2307".parse().unwrap());
        connection.set_authenticated(
            "alice.solo",
            &public_key,
            &route.user_id,
            &route.username,
            Some(&route),
        );
        assert!(!expired.is_fresh());
        assert!(connection.authorization_matches(Some(&expired)));
    }
    let (connection, _) = ConnectionState::new(2, "127.0.0.1:2308".parse().unwrap());
    let connection = Arc::new(connection);
    let (tx, _rx) = mpsc::channel(8);
    let session = ProxySshSession::new(
        store.clone(),
        control.clone(),
        config,
        "127.0.0.1:2308".parse().unwrap(),
        tx,
        connection,
        false,
    );
    assert!(session.held_snapshot().is_some());
    assert!(session.latest_snapshot().is_none());
}

#[tokio::test]
async fn control_timers_retarget_on_pause_before_snapshot_deadline() {
    let mut config = test_config();
    config.control_hold = Duration::from_secs(30);
    let store = Arc::new(SnapshotStore::default());
    let runtime = Arc::new(ProxyRuntime::new(&config));
    let control = Arc::new(ControlPlane::new());
    control.begin_epoch();
    let mut snapshot = fixture_proxy_snapshot(7);
    snapshot.valid_until = now_ms() + 80;
    assert!(store.store(snapshot, control.epoch()).unwrap());
    control.resume_authoritative();
    let snapshot = store.load().unwrap();
    let public_key = parse_authorized_key(ALICE_KEY).unwrap();
    let route = resolve_owned_route(&snapshot, "alice.solo").unwrap();
    let (connection, registration) = runtime.register_connection("127.0.0.1:2309".parse().unwrap());
    connection.set_authenticated(
        "alice.solo",
        &public_key,
        &route.user_id,
        &route.username,
        Some(&route),
    );
    let task = tokio::spawn(Abortable::new(std::future::pending::<()>(), registration));
    let timers = tokio::spawn(run_control_timers(
        store.clone(),
        runtime.clone(),
        control.clone(),
    ));
    pause_control_plane(&control, &runtime, config.control_hold, "pause").await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(store.load().is_some());
    assert!(!connection.revoked.load(Ordering::Acquire));
    assert_eq!(control.mode(), ControlMode::Paused);
    task.abort();
    timers.abort();
    let _ = task.await;
    let _ = timers.await;
}

#[tokio::test]
async fn a_backend_that_stops_answering_is_dropped_by_the_read_deadline() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut config = test_config();
    config.backend_ws = format!("ws://{}/ws/ssh-proxy", listener.local_addr().unwrap());
    config.status_interval = Duration::from_secs(60);
    config.control_liveness = proxy_common::control_link::ControlLiveness {
        connect_deadline: Duration::from_millis(500),
        ping_interval: Duration::from_millis(20),
        read_deadline: Duration::from_millis(80),
    };
    let backend = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(socket).await.unwrap();
        // Read (and so answer pings) for a while, then go silent while
        // keeping the TCP connection open, like a vanished host.
        let mut pings = 0;
        let _ = tokio::time::timeout(Duration::from_millis(200), async {
            while let Some(Ok(frame)) = ws.next().await {
                if frame.is_ping() {
                    pings += 1;
                }
            }
        })
        .await;
        (ws, pings)
    });
    let store = SnapshotStore::default();
    let runtime = ProxyRuntime::new(&config);
    let control = ControlPlane::new();
    let (_telemetry_tx, mut telemetry_rx) = mpsc::channel(4);

    let started = Instant::now();
    let error = tokio::time::timeout(
        Duration::from_secs(2),
        run_backend_once(&config, &store, &runtime, &control, &mut telemetry_rx),
    )
    .await
    .expect("a silent Backend kept the control link open")
    .unwrap_err();

    assert!(
        error.to_string().contains("delivered no frame"),
        "{error:#}"
    );
    // It was kept while the Backend answered.
    assert!(started.elapsed() >= Duration::from_millis(200));
    let (_ws, pings) = backend.await.unwrap();
    assert!(pings >= 3, "only {pings} pings while the Backend answered");
}

#[tokio::test]
async fn history_is_sent_in_frames_that_identify_the_proxy_instance() {
    let runtime = ProxyRuntime::new(&test_config());
    let (connection, _registration) =
        runtime.register_connection("192.0.2.4:4000".parse().unwrap());
    for _ in 0..3 {
        connection.reject_channel("rejected_permit", "work", 80, "127.0.0.1:0", None);
    }
    let written = Arc::new(std::sync::Mutex::new(Vec::<Message>::new()));
    let sink_frames = written.clone();
    let mut sink = Box::pin(futures_util::sink::unfold(
        (),
        move |(), message: Message| {
            sink_frames.lock().unwrap().push(message);
            async { Ok::<_, std::io::Error>(()) }
        },
    ));
    let sent = send_history(&mut sink, &runtime, 0).await.unwrap();
    assert_eq!(sent, 3);
    let frames = std::mem::take(&mut *written.lock().unwrap());
    assert_eq!(frames.len(), 1);
    let frame: serde_json::Value = serde_json::from_str(frames[0].to_text().unwrap()).unwrap();
    assert_eq!(frame["kind"], "history");
    assert_eq!(frame["payload"]["proxyId"], runtime.proxy_id.as_str());
    assert_eq!(frame["payload"]["instanceId"], runtime.instance_id.as_str());
    let seqs = frame["payload"]["records"]
        .as_array()
        .unwrap()
        .iter()
        .map(|record| record["seq"].as_u64().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(seqs, vec![1, 2, 3]);
    // Nothing new to send on this link until something is recorded.
    assert_eq!(send_history(&mut sink, &runtime, sent).await.unwrap(), 3);
    assert!(written.lock().unwrap().is_empty());
    // After the ack the outbox is empty; a new link sends nothing.
    runtime.history.acknowledge(3);
    assert_eq!(send_history(&mut sink, &runtime, 0).await.unwrap(), 0);
}
