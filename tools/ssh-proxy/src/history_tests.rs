use super::*;
use crate::runtime::ProxyRuntime;
use crate::snapshot::parse_authorized_key;
use crate::test_support::{fixture_snapshot, test_config, ALICE_KEY};
use futures_util::future::Abortable;
use pretty_assertions::assert_eq;
use serde_json::{json, Value};
use std::time::Duration;

fn sent(history: &HistoryLog) -> Vec<Value> {
    let mut after = 0;
    let mut records = Vec::new();
    while let Some((last, batch)) = history.next_batch(after) {
        records.extend(
            batch
                .iter()
                .map(|encoded| serde_json::from_str(encoded).unwrap()),
        );
        history.acknowledge(last);
        after = last;
    }
    records
}

fn connection_record(seq: u64) -> HistoryRecord {
    HistoryRecord::Connection(ConnectionRecord {
        connection_seq: seq,
        peer: "192.0.2.1:50000".to_string(),
        client_version: None,
        login: "alice".to_string(),
        user_id: "user-a".to_string(),
        username: "alice".to_string(),
        key_fingerprint: "SHA256:x".to_string(),
        key_algorithm: "ssh-ed25519".to_string(),
        pinned: None,
        connected_at: 1,
        authenticated_at: 2,
        closed_at: None,
        close_reason: None,
        bytes_from_client: 0,
        bytes_to_client: 0,
        channels_opened: 0,
        channels_rejected: 0,
        rejected_requests: BTreeMap::new(),
    })
}

#[test]
fn records_wait_until_acknowledged_and_are_sent_again_after_a_new_link() {
    let history = HistoryLog::default();
    history.record(connection_record(1));
    history.record(connection_record(2));

    let (last, batch) = history.next_batch(0).expect("two records to send");
    assert_eq!(last, 2);
    assert_eq!(batch.len(), 2);
    let first: Value = serde_json::from_str(&batch[0]).unwrap();
    assert_eq!(first["type"], "connection");
    assert_eq!(first["seq"], 1);
    assert_eq!(first["connectionSeq"], 1);
    // Nothing new after what this link sent.
    assert!(history.next_batch(2).is_none());
    // A new link starts from zero and sends the unacknowledged records again.
    assert_eq!(history.next_batch(0).unwrap().1.len(), 2);

    history.acknowledge(1);
    assert_eq!(history.backlog(), 1);
    assert_eq!(history.oldest_pending(), Some(2));
    history.acknowledge(2);
    assert_eq!(history.backlog(), 0);
    assert!(history.next_batch(0).is_none());
}

#[test]
fn a_full_outbox_drops_the_oldest_records_and_counts_them() {
    let history = HistoryLog::default();
    for seq in 0..(MAX_HISTORY_BACKLOG as u64 + 3) {
        history.record(connection_record(seq));
    }
    assert_eq!(history.backlog(), MAX_HISTORY_BACKLOG);
    assert_eq!(history.dropped(), 3);
    assert_eq!(history.oldest_pending(), Some(4));
}

#[test]
fn batches_respect_the_frame_size_and_the_in_flight_bound() {
    let history = HistoryLog::default();
    for seq in 0..(MAX_HISTORY_IN_FLIGHT as u64 + 10) {
        history.record(connection_record(seq));
    }
    let mut after = 0;
    let mut in_flight = 0;
    while let Some((last, batch)) = history.next_batch(after) {
        let bytes = batch.iter().map(|encoded| encoded.len() + 1).sum::<usize>();
        assert!(bytes <= MAX_HISTORY_FRAME_BYTES);
        in_flight += batch.len();
        after = last;
    }
    assert_eq!(in_flight, MAX_HISTORY_IN_FLIGHT);
    history.acknowledge(after);
    assert_eq!(history.next_batch(after).unwrap().1.len(), 10);
}

#[test]
fn refusals_are_summed_per_address_and_reason_for_each_window() {
    let history = HistoryLog::default();
    let ip = |last: u8| IpAddr::from([192, 0, 2, last]);
    history.refuse(ip(1), "public_key_rejected");
    history.refuse(ip(1), "public_key_rejected");
    history.refuse(ip(2), "no_auth");
    // Not over yet: nothing is sent.
    history.flush_refusals();
    assert!(history.next_batch(0).is_none());

    let start = {
        let mut outbox = lock(&history.outbox);
        let start = outbox.refusals.start;
        assert!(history.roll_refusals(&mut outbox, start + REFUSAL_WINDOW_MS));
        start
    };
    let records = sent(&history);
    assert_eq!(
        records,
        vec![json!({
            "type": "refusals",
            "seq": 1,
            "windowStart": start,
            "windowEnd": start + REFUSAL_WINDOW_MS,
            "refusals": [
                { "peerIp": "192.0.2.1", "reason": "public_key_rejected", "count": 2 },
                { "peerIp": "192.0.2.2", "reason": "no_auth", "count": 1 },
            ],
        })]
    );
}

#[test]
fn refusals_beyond_the_key_bound_are_counted_without_an_address() {
    let history = HistoryLog::default();
    for n in 0..(MAX_REFUSAL_KEYS as u32 + 5) {
        history.refuse(IpAddr::from(n.to_be_bytes()), "no_auth");
    }
    let outbox = lock(&history.outbox);
    assert_eq!(outbox.refusals.counts.len(), MAX_REFUSAL_KEYS + 1);
    assert_eq!(outbox.refusals.counts.get(&(None, "no_auth")), Some(&5));
}

#[test]
fn printable_cuts_client_text_to_bounded_ascii() {
    assert_eq!(printable("ok\u{1b}[31m\u{00e9}", 64), "ok?[31m?");
    assert_eq!(printable(&"x".repeat(300), 255).len(), 255);
}

#[tokio::test]
async fn a_connection_reports_its_channels_to_several_containers_and_why_each_closed() {
    let runtime = ProxyRuntime::new(&test_config());
    let snapshot = fixture_snapshot();
    let public_key = parse_authorized_key(ALICE_KEY).unwrap();
    let (connection, registration) =
        runtime.register_connection("192.0.2.9:40000".parse().unwrap());
    let connection_task = tokio::spawn(Abortable::new(std::future::pending::<()>(), registration));
    connection.set_authenticated("alice", &public_key, "user-a", "alice", None);
    connection.note_client_version(b"SSH-2.0-OpenSSH_9.6\r\n");
    connection.report_opened();

    let mut channels = Vec::new();
    for ip in ["10.0.0.2", "10.0.0.3"] {
        let route = snapshot
            .resolve_owned_route_for_user_ip("user-a", ip)
            .unwrap();
        let permit = connection.try_reserve_child_task().unwrap();
        permit.bind_route(&route);
        let channel =
            connection.open_channel(ip, 22, "127.0.0.1:0", ConnectionRouteInfo::from(&route));
        channel.bytes_from_client.fetch_add(10, Ordering::Relaxed);
        connection.record_from_client(10);
        permit.bind_channel(channel.clone());
        let open = crate::bridge::OpenChannel::new(connection.clone(), channel.clone());
        permit.spawn(async move {
            let _open = open;
            std::future::pending::<()>().await;
        });
        channels.push(channel);
    }
    connection.reject_channel("rejected_permit", "10.0.0.2", 80, "127.0.0.1:0", None);
    connection.count_rejected_request("session");
    tokio::task::yield_now().await;

    // The first container's route is revoked: only its bridge closes.
    let mut first_removed = crate::test_support::fixture_proxy_snapshot(8);
    first_removed
        .routes
        .retain(|route| route.container_id != "container-a");
    let first_removed = crate::snapshot::RoutingSnapshot::from_snapshot(first_removed).unwrap();
    runtime
        .disconnect_invalid(Some(&first_removed), "route revoked")
        .await;
    tokio::time::timeout(Duration::from_secs(1), async {
        while connection.channels.load(Ordering::Relaxed) != 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();

    connection.abort_because("disconnect_all");
    runtime.unregister_connection(&connection.id);
    tokio::time::timeout(Duration::from_secs(1), async {
        while connection.channels.load(Ordering::Relaxed) != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let _ = connection_task.await;

    let records = sent(&runtime.history);
    let connections = records
        .iter()
        .filter(|record| record["type"] == "connection")
        .collect::<Vec<_>>();
    assert_eq!(connections.len(), 2);
    assert_eq!(connections[0]["closedAt"], Value::Null);
    assert_eq!(connections[0]["clientVersion"], "SSH-2.0-OpenSSH_9.6");
    assert_eq!(connections[0]["keyAlgorithm"], "ssh-ed25519");
    assert!(connections[0]["keyFingerprint"]
        .as_str()
        .unwrap()
        .starts_with("SHA256:"));
    let closed = connections[1];
    assert_eq!(closed["closeReason"], "disconnect_all");
    assert_eq!(closed["bytesFromClient"], 20);
    assert_eq!(closed["channelsOpened"], 2);
    assert_eq!(closed["channelsRejected"], 1);
    assert_eq!(
        closed["rejectedRequests"],
        json!({ "rejected_permit": 1, "session": 1 })
    );

    let channel_closes = records
        .iter()
        .filter(|record| record["type"] == "channel" && record["closedAt"] != Value::Null)
        .map(|record| {
            (
                record["channelSeq"].as_u64().unwrap(),
                record["result"].as_str().unwrap().to_string(),
                record["closeReason"].clone(),
                record["route"]["serverId"].clone(),
            )
        })
        .collect::<Vec<_>>();
    let mut channel_closes = channel_closes;
    channel_closes.sort_by_key(|close| close.0);
    assert_eq!(
        channel_closes,
        vec![
            (1, "opened".to_string(), json!("revoked"), json!("server-a")),
            (
                2,
                "opened".to_string(),
                json!("connection_closed"),
                json!("server-b")
            ),
            (3, "rejected_permit".to_string(), Value::Null, Value::Null),
        ]
    );
}

#[test]
fn only_the_first_refused_channels_are_recorded_one_by_one() {
    let runtime = ProxyRuntime::new(&test_config());
    let (connection, _registration) =
        runtime.register_connection("192.0.2.9:40001".parse().unwrap());
    for _ in 0..(MAX_REJECTED_CHANNEL_RECORDS + 6) {
        connection.reject_channel("rejected_unauthorized", "other", 22, "127.0.0.1:0", None);
    }
    let records = sent(&runtime.history);
    assert_eq!(records.len(), MAX_REJECTED_CHANNEL_RECORDS as usize);
    let state = lock(&connection.history_state);
    assert_eq!(state.channels_rejected, MAX_REJECTED_CHANNEL_RECORDS + 6);
    assert_eq!(
        state.rejected_requests.get("rejected_unauthorized"),
        Some(&(MAX_REJECTED_CHANNEL_RECORDS + 6))
    );
}

#[test]
fn an_unauthenticated_connection_is_only_counted_as_a_refusal() {
    let runtime = ProxyRuntime::new(&test_config());
    let (offered, _a) = runtime.register_connection("192.0.2.7:1".parse().unwrap());
    offered.note_auth_failure("public_key_rejected");
    offered.set_close_reason("client_closed");
    runtime.unregister_connection(&offered.id);
    let (silent, _b) = runtime.register_connection("192.0.2.7:2".parse().unwrap());
    silent.set_close_reason("client_closed");
    runtime.unregister_connection(&silent.id);
    let (slow, _c) = runtime.register_connection("192.0.2.8:3".parse().unwrap());
    slow.set_close_reason("auth_timeout");
    runtime.unregister_connection(&slow.id);

    assert!(runtime.history.next_batch(0).is_none());
    let outbox = lock(&runtime.history.outbox);
    let ip = |last: u8| Some(IpAddr::from([192, 0, 2, last]));
    assert_eq!(
        outbox.refusals.counts.get(&(ip(7), "public_key_rejected")),
        Some(&1)
    );
    assert_eq!(outbox.refusals.counts.get(&(ip(7), "no_auth")), Some(&1));
    assert_eq!(
        outbox.refusals.counts.get(&(ip(8), "auth_timeout")),
        Some(&1)
    );
}
