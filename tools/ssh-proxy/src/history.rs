//! Connection history for the Backend.
//!
//! Every authenticated connection and each of its channels (refused ones
//! included) is reported as a full record when it opens and again when it
//! closes, so the Backend can upsert them in any order and a lost record is
//! repaired by the next one. Unauthenticated connections are internet noise:
//! they are only counted by (address, reason) per window.
//!
//! Records wait in a bounded outbox until the Backend acknowledges them, so a
//! dropped control link or a Backend restart loses nothing; only an outbox
//! overflow drops (the oldest) records, and that is counted in the status.

use crate::runtime::{lock, ConnectionRouteInfo, ConnectionState};
use proxy_common::clock::now_ms;
use russh::keys::{HashAlg, PublicKey};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::Notify;

/// Unacknowledged records kept; beyond this the oldest are dropped.
pub(crate) const MAX_HISTORY_BACKLOG: usize = 8192;
/// Upper bound of one `history` frame (the Backend closes frames over 1 MiB).
pub(crate) const MAX_HISTORY_FRAME_BYTES: usize = 256 * 1024;
/// Records sent but not yet acknowledged before sending pauses.
pub(crate) const MAX_HISTORY_IN_FLIGHT: usize = 2048;
/// Refused channels of one connection recorded one by one; the rest are only counted.
pub(crate) const MAX_REJECTED_CHANNEL_RECORDS: u32 = 64;
/// Unauthenticated connections are summed over windows of this length.
pub(crate) const REFUSAL_WINDOW_MS: u64 = 5 * 60_000;
/// Distinct (address, reason) pairs per window; the rest count without an address.
pub(crate) const MAX_REFUSAL_KEYS: usize = 256;
const MAX_TARGET_HOST_BYTES: usize = 255;
const MAX_ORIGINATOR_BYTES: usize = 128;
const MAX_CLIENT_VERSION_BYTES: usize = 255;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RouteRecord {
    pub(crate) server_id: String,
    pub(crate) server_slug: String,
    pub(crate) container_id: String,
    pub(crate) container_name: String,
    pub(crate) instance_name: String,
    pub(crate) routed_ip: String,
}

impl From<&ConnectionRouteInfo> for RouteRecord {
    fn from(route: &ConnectionRouteInfo) -> Self {
        Self {
            server_id: route.server_id.clone(),
            server_slug: route.server_slug.clone(),
            container_id: route.container_id.clone(),
            container_name: route.container_name.clone(),
            instance_name: route.instance_name.clone(),
            routed_ip: route.routed_ip.clone(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectionRecord {
    pub(crate) connection_seq: u64,
    pub(crate) peer: String,
    pub(crate) client_version: Option<String>,
    pub(crate) login: String,
    pub(crate) user_id: String,
    pub(crate) username: String,
    pub(crate) key_fingerprint: String,
    pub(crate) key_algorithm: String,
    pub(crate) pinned: Option<RouteRecord>,
    pub(crate) connected_at: u64,
    pub(crate) authenticated_at: u64,
    pub(crate) closed_at: Option<u64>,
    pub(crate) close_reason: Option<&'static str>,
    pub(crate) bytes_from_client: u64,
    pub(crate) bytes_to_client: u64,
    pub(crate) channels_opened: u32,
    pub(crate) channels_rejected: u32,
    /// Every refused request by kind: channel results and other requests.
    pub(crate) rejected_requests: BTreeMap<&'static str, u32>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChannelRecord {
    pub(crate) connection_seq: u64,
    pub(crate) channel_seq: u32,
    pub(crate) target_host: String,
    pub(crate) target_port: u32,
    pub(crate) originator: String,
    pub(crate) route: Option<RouteRecord>,
    /// `opened`, or the reason it was refused (the `ssh_proxy_channels_total` result).
    pub(crate) result: &'static str,
    pub(crate) opened_at: u64,
    pub(crate) closed_at: Option<u64>,
    pub(crate) close_reason: Option<&'static str>,
    pub(crate) bytes_from_client: u64,
    pub(crate) bytes_to_client: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RefusalCount {
    /// `None` once the window already holds `MAX_REFUSAL_KEYS` pairs.
    pub(crate) peer_ip: Option<String>,
    pub(crate) reason: &'static str,
    pub(crate) count: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RefusalRecord {
    pub(crate) window_start: u64,
    pub(crate) window_end: u64,
    pub(crate) refusals: Vec<RefusalCount>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum HistoryRecord {
    Connection(ConnectionRecord),
    Channel(ChannelRecord),
    Refusals(RefusalRecord),
}

struct RefusalWindow {
    start: u64,
    counts: HashMap<(Option<IpAddr>, &'static str), u64>,
}

struct Outbox {
    next_seq: u64,
    /// Unacknowledged records in sequence order, each already encoded.
    pending: VecDeque<(u64, String)>,
    refusals: RefusalWindow,
}

pub(crate) struct HistoryLog {
    outbox: Mutex<Outbox>,
    dropped: AtomicU64,
    changed: Notify,
}

impl Default for HistoryLog {
    fn default() -> Self {
        Self {
            outbox: Mutex::new(Outbox {
                next_seq: 1,
                pending: VecDeque::new(),
                refusals: RefusalWindow {
                    start: now_ms(),
                    counts: HashMap::new(),
                },
            }),
            dropped: AtomicU64::new(0),
            changed: Notify::new(),
        }
    }
}

impl HistoryLog {
    pub(crate) fn record(&self, record: HistoryRecord) {
        let mut outbox = lock(&self.outbox);
        self.push(&mut outbox, &record);
        drop(outbox);
        self.changed.notify_one();
    }

    fn push(&self, outbox: &mut Outbox, record: &HistoryRecord) {
        let seq = outbox.next_seq;
        let Ok(mut value) = serde_json::to_value(record) else {
            return;
        };
        value["seq"] = seq.into();
        outbox.next_seq += 1;
        outbox.pending.push_back((seq, value.to_string()));
        while outbox.pending.len() > MAX_HISTORY_BACKLOG {
            outbox.pending.pop_front();
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Counts one connection that ended (or was refused) unauthenticated.
    pub(crate) fn refuse(&self, ip: IpAddr, reason: &'static str) {
        let now = now_ms();
        let mut outbox = lock(&self.outbox);
        let flushed = self.roll_refusals(&mut outbox, now);
        let counts = &mut outbox.refusals.counts;
        let key = (Some(ip), reason);
        let key = if counts.contains_key(&key) || counts.len() < MAX_REFUSAL_KEYS {
            key
        } else {
            (None, reason)
        };
        *counts.entry(key).or_default() += 1;
        drop(outbox);
        if flushed {
            self.changed.notify_one();
        }
    }

    /// Emits the refusal window once it is over; called on every status tick.
    pub(crate) fn flush_refusals(&self) {
        let mut outbox = lock(&self.outbox);
        let flushed = self.roll_refusals(&mut outbox, now_ms());
        drop(outbox);
        if flushed {
            self.changed.notify_one();
        }
    }

    fn roll_refusals(&self, outbox: &mut Outbox, now: u64) -> bool {
        if now.saturating_sub(outbox.refusals.start) < REFUSAL_WINDOW_MS {
            return false;
        }
        let start = std::mem::replace(&mut outbox.refusals.start, now);
        if outbox.refusals.counts.is_empty() {
            return false;
        }
        let mut refusals = outbox
            .refusals
            .counts
            .drain()
            .map(|((ip, reason), count)| RefusalCount {
                peer_ip: ip.map(|ip| ip.to_string()),
                reason,
                count,
            })
            .collect::<Vec<_>>();
        refusals.sort_by(|a, b| (&a.peer_ip, a.reason).cmp(&(&b.peer_ip, b.reason)));
        let record = HistoryRecord::Refusals(RefusalRecord {
            window_start: start,
            window_end: now,
            refusals,
        });
        self.push(outbox, &record);
        true
    }

    /// The Backend stored every record up to and including `seq`.
    pub(crate) fn acknowledge(&self, seq: u64) {
        let mut outbox = lock(&self.outbox);
        while outbox
            .pending
            .front()
            .is_some_and(|(first, _)| *first <= seq)
        {
            outbox.pending.pop_front();
        }
    }

    /// The encoded records after `after` that fit one frame, with the last
    /// sequence number among them; `None` when nothing may be sent now
    /// (nothing new, or `MAX_HISTORY_IN_FLIGHT` records await their ack).
    pub(crate) fn next_batch(&self, after: u64) -> Option<(u64, Vec<String>)> {
        let outbox = lock(&self.outbox);
        let in_flight = outbox
            .pending
            .iter()
            .take_while(|(seq, _)| *seq <= after)
            .count();
        if in_flight >= MAX_HISTORY_IN_FLIGHT {
            return None;
        }
        let mut bytes = 0_usize;
        let mut last = after;
        let mut batch = Vec::new();
        for (seq, encoded) in outbox.pending.iter().skip(in_flight) {
            if !batch.is_empty()
                && (bytes + encoded.len() + 1 > MAX_HISTORY_FRAME_BYTES
                    || in_flight + batch.len() >= MAX_HISTORY_IN_FLIGHT)
            {
                break;
            }
            bytes += encoded.len() + 1;
            last = *seq;
            batch.push(encoded.clone());
        }
        (!batch.is_empty()).then_some((last, batch))
    }

    /// Lowest unacknowledged sequence number, if any.
    pub(crate) fn oldest_pending(&self) -> Option<u64> {
        lock(&self.outbox).pending.front().map(|(seq, _)| *seq)
    }

    pub(crate) fn backlog(&self) -> usize {
        lock(&self.outbox).pending.len()
    }

    pub(crate) fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    pub(crate) async fn changed(&self) {
        self.changed.notified().await;
    }
}

/// Per-connection facts only the history needs.
#[derive(Default)]
pub(crate) struct ConnectionHistory {
    pub(crate) client_version: Option<String>,
    pub(crate) key_fingerprint: Option<String>,
    pub(crate) key_algorithm: Option<String>,
    pub(crate) close_reason: Option<&'static str>,
    /// Why the last authentication attempt was refused.
    pub(crate) auth_failure: Option<&'static str>,
    pub(crate) next_channel_seq: u32,
    pub(crate) channels_opened: u32,
    pub(crate) channels_rejected: u32,
    pub(crate) rejected_requests: BTreeMap<&'static str, u32>,
}

/// One bridged `direct-tcpip` channel.
pub(crate) struct ChannelState {
    pub(crate) seq: u32,
    pub(crate) target_host: String,
    pub(crate) target_port: u32,
    pub(crate) originator: String,
    pub(crate) route: ConnectionRouteInfo,
    pub(crate) opened_at: u64,
    pub(crate) bytes_from_client: AtomicU64,
    pub(crate) bytes_to_client: AtomicU64,
    pub(crate) close_reason: Mutex<Option<&'static str>>,
}

impl ChannelState {
    pub(crate) fn set_close_reason(&self, reason: &'static str) {
        lock(&self.close_reason).get_or_insert(reason);
    }

    fn record(&self, connection_seq: u64, closed_at: Option<u64>) -> ChannelRecord {
        ChannelRecord {
            connection_seq,
            channel_seq: self.seq,
            target_host: self.target_host.clone(),
            target_port: self.target_port,
            originator: self.originator.clone(),
            route: Some(RouteRecord::from(&self.route)),
            result: "opened",
            opened_at: self.opened_at,
            closed_at,
            close_reason: closed_at
                .map(|_| lock(&self.close_reason).unwrap_or("connection_closed")),
            bytes_from_client: self.bytes_from_client.load(Ordering::Relaxed),
            bytes_to_client: self.bytes_to_client.load(Ordering::Relaxed),
        }
    }
}

/// Client-chosen text is stored and shown, so it is cut to printable ASCII.
pub(crate) fn printable(text: &str, max_bytes: usize) -> String {
    text.chars()
        .map(|c| if (' '..='~').contains(&c) { c } else { '?' })
        .take(max_bytes)
        .collect()
}

pub(crate) fn key_fingerprint(public_key: &PublicKey) -> String {
    public_key.fingerprint(HashAlg::Sha256).to_string()
}

impl ConnectionState {
    pub(crate) fn note_client_version(&self, sshid: &[u8]) {
        let version = printable(
            String::from_utf8_lossy(sshid).trim_end(),
            MAX_CLIENT_VERSION_BYTES,
        );
        lock(&self.history_state).client_version = (!version.is_empty()).then_some(version);
    }

    pub(crate) fn note_public_key(&self, public_key: &PublicKey) {
        let mut state = lock(&self.history_state);
        state.key_fingerprint = Some(key_fingerprint(public_key));
        state.key_algorithm = Some(public_key.algorithm().as_str().to_string());
    }

    pub(crate) fn note_auth_failure(&self, reason: &'static str) {
        lock(&self.history_state).auth_failure = Some(reason);
    }

    /// The first reason wins: an abort names why before the session unwinds.
    pub(crate) fn set_close_reason(&self, reason: &'static str) {
        lock(&self.history_state).close_reason.get_or_insert(reason);
    }

    pub(crate) fn count_rejected_request(&self, kind: &'static str) {
        *lock(&self.history_state)
            .rejected_requests
            .entry(kind)
            .or_default() += 1;
    }

    fn connection_record(&self, closed_at: Option<u64>) -> Option<ConnectionRecord> {
        let authenticated_at = self.authenticated_at.load(Ordering::Acquire);
        if authenticated_at == 0 {
            return None;
        }
        let state = lock(&self.history_state);
        Some(ConnectionRecord {
            connection_seq: self.sequence,
            peer: self.peer.clone(),
            client_version: state.client_version.clone(),
            login: lock(&self.login).clone().unwrap_or_default(),
            user_id: lock(&self.authenticated_user_id).clone()?,
            username: lock(&self.authenticated_username).clone()?,
            key_fingerprint: state.key_fingerprint.clone()?,
            key_algorithm: state.key_algorithm.clone()?,
            pinned: lock(&self.pinned_route).as_ref().map(RouteRecord::from),
            connected_at: self.connected_at,
            authenticated_at,
            closed_at,
            close_reason: closed_at.map(|_| state.close_reason.unwrap_or("closed")),
            bytes_from_client: self.bytes_from_client.load(Ordering::Relaxed),
            bytes_to_client: self.bytes_to_client.load(Ordering::Relaxed),
            channels_opened: state.channels_opened,
            channels_rejected: state.channels_rejected,
            rejected_requests: state.rejected_requests.clone(),
        })
    }

    /// Reports the connection once it is authenticated.
    pub(crate) fn report_opened(&self) {
        if let (Some(history), Some(record)) = (&self.history, self.connection_record(None)) {
            history.record(HistoryRecord::Connection(record));
        }
    }

    /// Reports the end of the connection: its final record, or one refusal
    /// when it never authenticated.
    pub(crate) fn report_closed(&self) {
        let Some(history) = &self.history else {
            return;
        };
        if let Some(record) = self.connection_record(Some(now_ms())) {
            history.record(HistoryRecord::Connection(record));
            return;
        }
        let Ok(peer) = self.peer.parse::<SocketAddr>() else {
            return;
        };
        let state = lock(&self.history_state);
        let reason = state
            .auth_failure
            .or(state
                .close_reason
                .filter(|reason| *reason != "client_closed"))
            .unwrap_or("no_auth");
        drop(state);
        history.refuse(peer.ip(), reason);
    }

    /// Records a bridged channel as opened and returns its live state.
    pub(crate) fn open_channel(
        &self,
        target_host: &str,
        target_port: u32,
        originator: &str,
        route: ConnectionRouteInfo,
    ) -> Arc<ChannelState> {
        let seq = {
            let mut state = lock(&self.history_state);
            state.channels_opened = state.channels_opened.saturating_add(1);
            state.next_channel_seq = state.next_channel_seq.saturating_add(1);
            state.next_channel_seq
        };
        let channel = Arc::new(ChannelState {
            seq,
            target_host: printable(target_host, MAX_TARGET_HOST_BYTES),
            target_port,
            originator: printable(originator, MAX_ORIGINATOR_BYTES),
            route,
            opened_at: now_ms(),
            bytes_from_client: AtomicU64::new(0),
            bytes_to_client: AtomicU64::new(0),
            close_reason: Mutex::new(None),
        });
        if let Some(history) = &self.history {
            history.record(HistoryRecord::Channel(channel.record(self.sequence, None)));
        }
        channel
    }

    pub(crate) fn close_channel(&self, channel: &ChannelState) {
        if let Some(history) = &self.history {
            history.record(HistoryRecord::Channel(
                channel.record(self.sequence, Some(now_ms())),
            ));
        }
    }

    /// Counts a refused channel and records the first ones one by one.
    pub(crate) fn reject_channel(
        &self,
        result: &'static str,
        target_host: &str,
        target_port: u32,
        originator: &str,
        route: Option<&ConnectionRouteInfo>,
    ) {
        let seq = {
            let mut state = lock(&self.history_state);
            *state.rejected_requests.entry(result).or_default() += 1;
            state.channels_rejected = state.channels_rejected.saturating_add(1);
            if state.channels_rejected > MAX_REJECTED_CHANNEL_RECORDS {
                return;
            }
            state.next_channel_seq = state.next_channel_seq.saturating_add(1);
            state.next_channel_seq
        };
        let Some(history) = &self.history else {
            return;
        };
        let now = now_ms();
        history.record(HistoryRecord::Channel(ChannelRecord {
            connection_seq: self.sequence,
            channel_seq: seq,
            target_host: printable(target_host, MAX_TARGET_HOST_BYTES),
            target_port,
            originator: printable(originator, MAX_ORIGINATOR_BYTES),
            route: route.map(RouteRecord::from),
            result,
            opened_at: now,
            closed_at: Some(now),
            close_reason: None,
            bytes_from_client: 0,
            bytes_to_client: 0,
        }));
    }
}

#[cfg(test)]
#[path = "history_tests.rs"]
mod tests;
