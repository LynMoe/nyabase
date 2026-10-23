use super::*;
use crate::control::install_snapshot;
use crate::request::read_request_head;
use crate::snapshot::{SnapshotCertResolver, SnapshotStore};
use crate::test_support::*;
use std::sync::atomic::Ordering;
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

fn runtime_with_idle(idle: Duration) -> Arc<crate::runtime::Runtime> {
    Arc::new({
        let mut runtime = Arc::try_unwrap(test_runtime()).ok().unwrap();
        runtime.limits.idle = idle;
        runtime
    })
}

#[tokio::test]
async fn a_silent_upstream_hits_the_idle_timeout_and_aborts_the_client() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_port = listener.local_addr().unwrap().port();
    let upstream = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let _ = read_request_head(&mut socket).await.unwrap();
        // A close-delimited response that stalls half way.
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\npartial")
            .await
            .unwrap();
        std::future::pending::<()>().await;
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
        runtime_with_idle(Duration::from_millis(50)),
    ));
    client
        .write_all(b"GET /slow HTTP/1.1\r\nHost: app.example.test\r\n\r\n")
        .await
        .unwrap();

    let error = time::timeout(Duration::from_secs(1), handler)
        .await
        .expect("silent upstream did not reach the idle timeout")
        .unwrap()
        .unwrap_err();
    assert!(error.to_string().contains("idle timeout"), "{error}");
    assert!(crate::relay::is_client_abort(&error));
    upstream.abort();
}

#[tokio::test]
async fn a_steady_stream_outlives_the_idle_timeout() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_port = listener.local_addr().unwrap().port();
    let upstream = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let _ = read_request_head(&mut socket).await.unwrap();
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
            .await
            .unwrap();
        for _ in 0..12 {
            time::sleep(Duration::from_millis(25)).await;
            socket.write_all(b"data: tick\n\n").await.unwrap();
        }
        socket.shutdown().await.unwrap();
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
        runtime_with_idle(Duration::from_millis(100)),
    ));
    client
        .write_all(b"GET /events HTTP/1.1\r\nHost: app.example.test\r\n\r\n")
        .await
        .unwrap();
    let mut response = Vec::new();
    time::timeout(Duration::from_secs(3), client.read_to_end(&mut response))
        .await
        .expect("stream did not finish")
        .unwrap();
    let response = String::from_utf8(response).unwrap();
    assert_eq!(response.matches("data: tick").count(), 12, "{response}");
    handler.await.unwrap().unwrap();
    upstream.await.unwrap();
}

#[tokio::test]
async fn a_cut_close_delimited_response_resets_the_client_socket() {
    let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_port = upstream_listener.local_addr().unwrap().port();
    let upstream = tokio::spawn(async move {
        let (mut socket, _) = upstream_listener.accept().await.unwrap();
        let _ = read_request_head(&mut socket).await.unwrap();
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\npartial")
            .await
            .unwrap();
        std::future::pending::<()>().await;
    });
    let store = Arc::new(SnapshotStore::default());
    store
        .store(test_snapshot(1, 30_000, vec![test_route(upstream_port)]))
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(serve_http(
        listener,
        store,
        runtime_with_idle(Duration::from_millis(100)),
        proxy_common::conn_limit::ConnectionLimiter::new(
            proxy_common::conn_limit::LimitSettings::basic(16, 16),
        ),
        false,
    ));
    let mut client = tokio::net::TcpStream::connect(address).await.unwrap();
    client
        .write_all(b"GET /download HTTP/1.1\r\nHost: app.example.test\r\n\r\n")
        .await
        .unwrap();
    let mut response = Vec::new();
    let result = time::timeout(Duration::from_secs(2), client.read_to_end(&mut response))
        .await
        .expect("client was neither reset nor closed");
    let error = result.expect_err("a truncated response must not end cleanly");
    assert_eq!(error.kind(), std::io::ErrorKind::ConnectionReset);
    server.abort();
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

async fn connect_from(source: &str, target: std::net::SocketAddr) -> tokio::net::TcpStream {
    let socket = tokio::net::TcpSocket::new_v4().unwrap();
    socket.bind(format!("{source}:0").parse().unwrap()).unwrap();
    socket.connect(target).await.unwrap()
}

async fn closed_without_reply(stream: &mut tokio::net::TcpStream) -> bool {
    let mut byte = [0_u8; 1];
    matches!(
        time::timeout(Duration::from_secs(1), stream.read(&mut byte)).await,
        Ok(Ok(0)) | Ok(Err(_))
    )
}

#[tokio::test]
async fn one_client_ip_cannot_take_more_than_its_share_of_connections() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let store = Arc::new(SnapshotStore::default());
    let runtime = test_runtime();
    let limiter = proxy_common::conn_limit::ConnectionLimiter::new(
        proxy_common::conn_limit::LimitSettings::basic(16, 2),
    );
    let server = tokio::spawn(serve_http(
        listener,
        store,
        runtime.clone(),
        limiter.clone(),
        false,
    ));

    let first = connect_from("127.0.0.1", address).await;
    let _second = connect_from("127.0.0.1", address).await;
    time::timeout(Duration::from_secs(1), async {
        while limiter.active_for("127.0.0.1".parse().unwrap()) < 2 {
            time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();

    let mut third = connect_from("127.0.0.1", address).await;
    assert!(closed_without_reply(&mut third).await);
    assert!(runtime.total_rejected_requests.load(Ordering::Relaxed) >= 1);

    // Another client address is still served.
    let mut other = connect_from("127.0.0.2", address).await;
    other
        .write_all(b"GET / HTTP/1.1\r\nHost: unknown.example.test\r\n\r\n")
        .await
        .unwrap();
    let mut response = Vec::new();
    other.read_to_end(&mut response).await.unwrap();
    assert!(String::from_utf8(response)
        .unwrap()
        .starts_with("HTTP/1.1 404 Not Found"));

    // Closing a connection frees the slot for that address again.
    drop(first);
    time::timeout(Duration::from_secs(1), async {
        while limiter.active_for("127.0.0.1".parse().unwrap()) >= 2 {
            time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let mut again = connect_from("127.0.0.1", address).await;
    again
        .write_all(b"GET / HTTP/1.1\r\nHost: unknown.example.test\r\n\r\n")
        .await
        .unwrap();
    let mut response = Vec::new();
    again.read_to_end(&mut response).await.unwrap();
    assert!(String::from_utf8(response)
        .unwrap()
        .starts_with("HTTP/1.1 404 Not Found"));
    server.abort();
}

#[tokio::test]
async fn connections_without_a_request_head_cannot_fill_the_pool() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let limiter =
        proxy_common::conn_limit::ConnectionLimiter::new(proxy_common::conn_limit::LimitSettings {
            global: 8,
            per_client: 8,
            per_site: 8,
            pending: 1,
        });
    let server = tokio::spawn(serve_http(
        listener,
        Arc::new(SnapshotStore::default()),
        test_runtime(),
        limiter.clone(),
        false,
    ));

    let _silent = connect_from("127.0.0.1", address).await;
    time::timeout(Duration::from_secs(1), async {
        while limiter.pending_available() > 0 {
            time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let mut refused = connect_from("127.0.0.2", address).await;
    assert!(closed_without_reply(&mut refused).await);
    assert_eq!(limiter.active_for("127.0.0.2".parse().unwrap()), 0);
    server.abort();
}

#[tokio::test]
async fn reading_the_request_head_releases_the_pending_slot() {
    let store = Arc::new(SnapshotStore::default());
    let limiter =
        proxy_common::conn_limit::ConnectionLimiter::new(proxy_common::conn_limit::LimitSettings {
            global: 8,
            per_client: 8,
            per_site: 8,
            pending: 1,
        });
    let mut permit = limiter.try_acquire("192.0.2.1".parse().unwrap()).unwrap();
    let accepted = Accepted {
        peer: "192.0.2.1:5000".parse().unwrap(),
        https: false,
        pending: permit.take_pending(),
    };
    let (mut client, mut proxy_side) = tokio::io::duplex(4096);
    let runtime = test_runtime();
    let handler =
        tokio::spawn(
            async move { handle_accepted(&mut proxy_side, accepted, store, runtime).await },
        );
    time::sleep(Duration::from_millis(20)).await;
    assert_eq!(limiter.pending_available(), 0);
    client
        .write_all(b"GET / HTTP/1.1\r\nHost: unknown.example.test\r\n\r\n")
        .await
        .unwrap();
    let mut response = Vec::new();
    client.read_to_end(&mut response).await.unwrap();
    handler.await.unwrap().unwrap();
    assert_eq!(limiter.pending_available(), 1);
    drop(permit);
}
