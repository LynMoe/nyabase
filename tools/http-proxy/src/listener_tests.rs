use super::*;
use crate::control::install_snapshot;
use crate::request::read_request_head;
use crate::snapshot::{SnapshotCertResolver, SnapshotStore};
use crate::test_support::*;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::time;
use tokio_rustls::TlsAcceptor;

#[tokio::test]
async fn silent_tls_clients_are_closed_by_the_handshake_deadline() {
    rustls::crypto::ring::default_provider()
        .install_default()
        .ok();
    let resolver = Arc::new(SnapshotCertResolver {
        store: Arc::new(SnapshotStore::default()),
    });
    let config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_cert_resolver(resolver);
    let acceptor = TlsAcceptor::from(Arc::new(config));
    let (_silent_client, server) = tokio::io::duplex(1024);

    let Err(error) = accept_tls_with_deadline(&acceptor, server, Duration::from_millis(5)).await
    else {
        panic!("silent TLS client unexpectedly completed a handshake");
    };

    assert!(error.to_string().contains("deadline exceeded"));
}

#[tokio::test]
async fn fixed_http_request_retains_the_absolute_lifetime_deadline() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_port = listener.local_addr().unwrap().port();
    let upstream = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let _ = read_request_head(&mut socket).await.unwrap();
        std::future::pending::<()>().await;
    });
    let route = test_route(upstream_port);
    let store = Arc::new(SnapshotStore::default());
    store.store(test_snapshot(1, 30_000, vec![route])).unwrap();
    let runtime = test_runtime();
    let (mut client, proxy_side) = tokio::io::duplex(4096);
    let handler = tokio::spawn(handle_connection_with_fixed_request_deadline(
        proxy_side,
        "127.0.0.1:12345".parse().unwrap(),
        store,
        runtime,
        Duration::from_millis(10),
    ));
    client
        .write_all(b"GET /slow HTTP/1.1\r\nHost: app.example.test\r\n\r\n")
        .await
        .unwrap();

    let result = time::timeout(Duration::from_secs(1), handler)
        .await
        .expect("fixed HTTP request did not reach its lifetime deadline")
        .unwrap();
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("request lifetime deadline exceeded"));
    upstream.abort();
}

#[tokio::test]
async fn snapshot_expiry_interrupts_an_established_slow_request() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_port = listener.local_addr().unwrap().port();
    let upstream = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = [0_u8; 1024];
        let _ = socket.read(&mut request).await.unwrap();
        std::future::pending::<()>().await;
    });

    let route = test_route(upstream_port);
    let store = Arc::new(SnapshotStore::default());
    install_snapshot(&store, test_snapshot(1, 50, vec![route])).unwrap();
    let runtime = test_runtime();
    let (mut client, proxy_side) = tokio::io::duplex(4096);
    let handler = tokio::spawn(handle_connection(
        proxy_side,
        "127.0.0.1:12345".parse().unwrap(),
        store,
        runtime,
    ));
    client
        .write_all(b"GET /slow HTTP/1.1\r\nHost: app.example.test\r\n\r\n")
        .await
        .unwrap();

    let result = time::timeout(Duration::from_secs(2), handler)
        .await
        .expect("request did not stop at snapshot expiry")
        .unwrap();
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("authorization was revoked"));
    upstream.abort();
}
