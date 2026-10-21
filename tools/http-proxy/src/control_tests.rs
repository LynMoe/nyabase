use super::*;
use crate::protocol::{control_ack_message, ProxySnapshot};
use crate::snapshot::SnapshotStore;
use proxy_common::clock::now_ms;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Error as WebSocketError;

#[test]
fn control_ack_is_a_complete_protocol_envelope() {
    let ack: serde_json::Value = serde_json::from_str(&control_ack_message(7)).unwrap();
    assert!(ack["ts"].as_u64().is_some());
    assert_eq!(ack["kind"], "ack");
    assert_eq!(ack["payload"]["generation"], 7);
}

#[tokio::test]
async fn a_stuck_control_writer_hits_a_hard_deadline() {
    let store = SnapshotStore::default();
    store
        .store(ProxySnapshot {
            generation: 1,
            stale_after_ms: 30_000,
            valid_until_ms: now_ms() + 30_000,
            routes: Vec::new(),
            domain_pools: Vec::new(),
        })
        .unwrap();
    let pending = std::future::pending::<std::result::Result<(), WebSocketError>>();
    let error = control_write_or_revoke(&store, Duration::from_millis(5), pending)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("deadline exceeded"));
    assert!(store.load().is_none());
}
