use super::*;
use crate::control::{pause_control_plane, ControlPlane};
use crate::runtime::{ConnectionState, ProxyRuntime};
use crate::snapshot::SnapshotStore;
use crate::test_support::*;
use anyhow::Result;
use futures_util::future::{AbortHandle, Abortable};
use russh::keys::decode_secret_key;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncReadExt as _;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

#[tokio::test]
async fn revocation_shutdown_closes_a_detached_session_socket() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let client = TcpStream::connect(address).await.unwrap();
    let (mut peer, _) = listener.accept().await.unwrap();
    let (session_stream, socket_guard) = revocable_session_stream(client).unwrap();

    // Model russh's private JoinHandle retaining its duplicated descriptor
    // after the owning connection future has been cancelled.
    let detached_session = tokio::spawn(async move {
        let _session_stream = session_stream;
        std::future::pending::<()>().await;
    });
    let (abort, registration) = AbortHandle::new_pair();
    let owner = tokio::spawn(Abortable::new(
        async move {
            let _socket_guard = socket_guard;
            std::future::pending::<()>().await;
        },
        registration,
    ));
    abort.abort();
    assert!(owner.await.unwrap().is_err());

    let mut byte = [0_u8; 1];
    let read = tokio::time::timeout(Duration::from_millis(250), peer.read(&mut byte))
        .await
        .expect("peer did not observe bounded revocation shutdown");
    assert!(matches!(read, Ok(0) | Err(_)));
    detached_session.abort();
    let _ = detached_session.await;
}

struct TrustAllClient;

impl russh::client::Handler for TrustAllClient {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

#[tokio::test]
async fn paused_handle_ssh_connection_disconnects_ok() {
    let config = test_config();
    let store = Arc::new(SnapshotStore::default());
    let control = paused_plane(store.as_ref());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn({
        let store = store.clone();
        let control = control.clone();
        let config = config.clone();
        async move {
            let (stream, peer) = listener.accept().await.unwrap();
            let (connection, _) = ConnectionState::new(1, peer);
            let (tx, _rx) = mpsc::channel(8);
            handle_ssh_connection(
                stream,
                peer,
                store,
                control,
                config,
                tx,
                Arc::new(connection),
                true,
            )
            .await
        }
    });
    let mut handle = russh::client::connect(
        Arc::new(russh::client::Config::default()),
        addr,
        TrustAllClient,
    )
    .await
    .expect("client connect");
    let key = decode_secret_key(TEST_PRIVATE_KEY, None).unwrap();
    let _auth = handle
        .authenticate_publickey(
            "alice.solo",
            russh::keys::PrivateKeyWithHashAlg::new(Arc::new(key), None),
        )
        .await;
    let channel = handle
        .channel_open_direct_tcpip("10.0.0.4", 22, "127.0.0.1", 1)
        .await;
    assert!(
        channel.is_err(),
        "paused reject must not open a forward: {channel:?}"
    );
    let server_result = tokio::time::timeout(Duration::from_secs(2), server)
        .await
        .expect("server finished")
        .expect("join");
    assert!(server_result.is_ok(), "{server_result:?}");
}

#[tokio::test]
async fn pre_auth_connections_are_closed_on_pause() {
    let config = test_config();
    let runtime = ProxyRuntime::new(&config);
    let control = ControlPlane::new();
    control.begin_epoch();
    SnapshotStore::default()
        .store(fixture_proxy_snapshot(7), control.epoch())
        .unwrap();
    control.resume_authoritative();
    let (connection, registration) = runtime.register_connection("127.0.0.1:2306".parse().unwrap());
    let task = tokio::spawn(Abortable::new(std::future::pending::<()>(), registration));
    pause_control_plane(&control, &runtime, config.control_hold, "pause").await;
    assert!(tokio::time::timeout(Duration::from_millis(100), task)
        .await
        .expect("pre-auth must abort")
        .expect("join")
        .is_err());
    assert!(connection.revoked.load(Ordering::Acquire));
}

#[tokio::test]
async fn auth_deadline_only_fires_for_unauthenticated_sessions() {
    let (pending_connection, _) = ConnectionState::new(1, "127.0.0.1:2400".parse().unwrap());
    let error = with_auth_deadline(
        std::future::pending::<Result<()>>(),
        &pending_connection,
        Duration::from_millis(20),
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("authentication deadline"));

    let (authenticated, _) = ConnectionState::new(2, "127.0.0.1:2401".parse().unwrap());
    authenticated
        .authenticated_at
        .store(1, std::sync::atomic::Ordering::Release);
    let outlived = tokio::time::timeout(
        Duration::from_millis(100),
        with_auth_deadline(
            std::future::pending::<Result<()>>(),
            &authenticated,
            Duration::from_millis(20),
        ),
    )
    .await;
    assert!(
        outlived.is_err(),
        "authenticated session was cut by the auth deadline"
    );
}

struct PublicListener {
    address: std::net::SocketAddr,
    task: tokio::task::JoinHandle<Result<()>>,
    _telemetry: mpsc::Receiver<crate::protocol::ProxyEvent>,
}

async fn start_public_listener(config: crate::config::ProxyConfig) -> PublicListener {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let store = Arc::new(SnapshotStore::default());
    let control = Arc::new(ControlPlane::new());
    control.begin_epoch();
    assert!(store
        .store(fixture_proxy_snapshot(7), control.epoch())
        .unwrap());
    control.resume_authoritative();
    let runtime = Arc::new(ProxyRuntime::new(&config));
    let (tx, rx) = mpsc::channel(1024);
    let task = tokio::spawn(serve_public(listener, config, store, runtime, control, tx));
    PublicListener {
        address,
        task,
        _telemetry: rx,
    }
}

async fn connect_from(source: &str, target: std::net::SocketAddr) -> TcpStream {
    let socket = tokio::net::TcpSocket::new_v4().unwrap();
    socket.bind(format!("{source}:0").parse().unwrap()).unwrap();
    socket.connect(target).await.unwrap()
}

/// Reads the server's SSH identification line, or `None` if the socket was
/// closed without one.
async fn read_banner(stream: &mut TcpStream) -> Option<String> {
    let mut banner = Vec::new();
    let mut byte = [0_u8; 1];
    loop {
        match tokio::time::timeout(Duration::from_secs(2), stream.read(&mut byte))
            .await
            .expect("no banner or close within the timeout")
        {
            Ok(0) | Err(_) => return None,
            Ok(_) => {
                banner.push(byte[0]);
                if byte[0] == b'\n' {
                    return Some(String::from_utf8_lossy(&banner).into_owned());
                }
            }
        }
    }
}

#[tokio::test]
async fn silent_pre_auth_clients_are_closed_by_the_auth_deadline() {
    let mut config = test_config();
    config.auth_timeout = Duration::from_millis(200);
    let listener = start_public_listener(config).await;
    let mut client = TcpStream::connect(listener.address).await.unwrap();
    let banner = read_banner(&mut client).await.expect("server banner");
    assert!(banner.starts_with("SSH-2.0-"));

    let started = std::time::Instant::now();
    let mut buffer = [0_u8; 256];
    let closed = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            match client.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(_) => continue,
            }
        }
    })
    .await;
    assert!(closed.is_ok(), "pre-auth client outlived the auth deadline");
    assert!(started.elapsed() >= Duration::from_millis(100));
    listener.task.abort();
}

#[tokio::test]
async fn one_client_ip_cannot_exhaust_pre_auth_slots() {
    let mut config = test_config();
    config.max_connections_per_ip = 2;
    let listener = start_public_listener(config).await;

    let mut first = connect_from("127.0.0.1", listener.address).await;
    let mut second = connect_from("127.0.0.1", listener.address).await;
    assert!(read_banner(&mut first).await.is_some());
    assert!(read_banner(&mut second).await.is_some());
    let mut third = connect_from("127.0.0.1", listener.address).await;
    assert!(read_banner(&mut third).await.is_none());

    let mut other = connect_from("127.0.0.2", listener.address).await;
    assert!(read_banner(&mut other).await.is_some());

    drop(first);
    let mut retry = None;
    for _ in 0..100 {
        let mut candidate = connect_from("127.0.0.1", listener.address).await;
        if read_banner(&mut candidate).await.is_some() {
            retry = Some(candidate);
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(
        retry.is_some(),
        "closing a connection did not free its slot"
    );
    listener.task.abort();
}

#[tokio::test]
async fn pre_auth_sockets_cannot_fill_the_whole_pool() {
    let mut config = test_config();
    config.max_connections = 8;
    config.max_preauth_connections = 2;
    let listener = start_public_listener(config).await;

    // Different addresses, so only the pre-auth cap can refuse the third.
    let mut first = connect_from("127.0.0.1", listener.address).await;
    let mut second = connect_from("127.0.0.2", listener.address).await;
    assert!(read_banner(&mut first).await.is_some());
    assert!(read_banner(&mut second).await.is_some());
    let mut third = connect_from("127.0.0.3", listener.address).await;
    assert!(read_banner(&mut third).await.is_none());
    listener.task.abort();
}

#[test]
fn authentication_releases_the_pre_auth_slot_but_not_the_connection_slot() {
    use proxy_common::conn_limit::{ConnectionLimiter, LimitSettings};
    let limiter = ConnectionLimiter::new(LimitSettings {
        global: 4,
        per_client: 4,
        per_site: 4,
        pending: 1,
    });
    let peer: std::net::SocketAddr = "127.0.0.1:2700".parse().unwrap();
    let mut permit = limiter.try_acquire(peer.ip()).unwrap();
    let (connection, _) = ConnectionState::new(1, peer);
    connection.hold_pending(permit.take_pending());
    assert_eq!(limiter.pending_available(), 0);
    assert!(limiter.try_acquire(peer.ip()).is_err());

    let public_key = crate::snapshot::parse_authorized_key(ALICE_KEY).unwrap();
    connection.set_authenticated("alice", &public_key, "user-a", "alice", None);
    assert_eq!(limiter.pending_available(), 1);
    assert_eq!(limiter.active_for(peer.ip()), 1);
    drop(permit);
    assert_eq!(limiter.active_for(peer.ip()), 0);
}
