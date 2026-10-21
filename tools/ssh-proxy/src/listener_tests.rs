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
