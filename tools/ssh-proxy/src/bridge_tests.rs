use super::*;
use crate::protocol::{ProxyEvent, SshProxyAuditEvent};
use crate::runtime::ConnectionState;
use pretty_assertions::assert_eq;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tokio::io::AsyncReadExt as _;
use tokio::io::AsyncWriteExt as _;
use tokio::sync::mpsc;

#[tokio::test]
async fn metered_channel_stream_counts_bytes_while_io_is_in_flight() {
    let (left, right) = tokio::io::duplex(1024);
    let (state, _registration) = ConnectionState::new(99, "127.0.0.1:2222".parse().unwrap());
    let connection = Arc::new(state);
    let mut metered = MeteredChannelStream::new(left, connection.clone());
    let mut peer = right;

    peer.write_all(b"from-client").await.unwrap();
    let mut buf = [0_u8; 32];
    let n = metered.read(&mut buf).await.unwrap();
    assert_eq!(&buf[..n], b"from-client");
    assert_eq!(
        connection.bytes_from_client.load(Ordering::Relaxed),
        b"from-client".len() as u64
    );

    metered.write_all(b"to-client").await.unwrap();
    metered.flush().await.unwrap();
    let n = peer.read(&mut buf).await.unwrap();
    assert_eq!(&buf[..n], b"to-client");
    assert_eq!(
        connection.bytes_to_client.load(Ordering::Relaxed),
        b"to-client".len() as u64
    );
}

#[test]
fn telemetry_helpers_enqueue_metric_and_audit_events() {
    let (tx, mut rx) = mpsc::channel(2);
    emit_metric(
        &tx,
        "ssh_proxy_test_total",
        vec![("result", "ok".to_string())],
        1.0,
    );
    emit_audit(
        &tx,
        SshProxyAuditEvent {
            user_id: Some("user-a".to_string()),
            username: Some("alice".to_string()),
            container_id: Some("container-a".to_string()),
            server_id: Some("server-a".to_string()),
            action: "login".to_string(),
            ok: true,
            reason: None,
            ts: 1,
        },
    );

    let Some(ProxyEvent::Metric(metric)) = rx.try_recv().ok() else {
        panic!("expected metric event");
    };
    assert_eq!(metric.name, "ssh_proxy_test_total");
    assert_eq!(metric.labels.get("result"), Some(&"ok".to_string()));

    let Some(ProxyEvent::Audit(audit)) = rx.try_recv().ok() else {
        panic!("expected audit event");
    };
    assert_eq!(audit.action, "login");
    assert!(audit.ok);
}
