//! Per-binding traffic counters, cumulative since process start.
//!
//! The hot path only touches atomics of an `Arc<BindingCounters>` it looked
//! up once per request; the map lock is taken once per request and once per
//! status report.

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::task::{Context, Poll};
use std::time::Instant;
use tokio::io::{self, AsyncRead, AsyncWrite, ReadBuf};

/// Same bound as the Backend's `MAX_HTTP_PROXY_ROUTES` (16 servers x 64
/// containers): one status report never lists more bindings than that.
pub(crate) const MAX_REPORTED_BINDINGS: usize = 1_024;
/// Counters of bindings that left the snapshot are kept (unreported) so a
/// binding that comes back, e.g. after its container restarts, continues
/// from its old totals instead of restarting from zero; beyond this many
/// entries the longest-gone idle ones are forgotten.
pub(crate) const MAX_RETAINED_BINDINGS: usize = 4 * MAX_REPORTED_BINDINGS;

#[derive(Debug, Default)]
pub(crate) struct BindingCounters {
    pub(crate) requests: AtomicU64,
    pub(crate) active_connections: AtomicU64,
    pub(crate) rx_bytes: AtomicU64,
    pub(crate) tx_bytes: AtomicU64,
}

impl BindingCounters {
    pub(crate) fn count_request(&self) {
        self.requests.fetch_add(1, Ordering::Relaxed);
    }

    /// Holds one active connection until the returned guard drops, on every
    /// exit path (an upgraded tunnel included).
    pub(crate) fn open_relay(self: &Arc<Self>) -> ActiveRelayGuard {
        self.active_connections.fetch_add(1, Ordering::Relaxed);
        ActiveRelayGuard {
            counters: self.clone(),
        }
    }
}

pub(crate) struct ActiveRelayGuard {
    counters: Arc<BindingCounters>,
}

impl Drop for ActiveRelayGuard {
    fn drop(&mut self) {
        self.counters
            .active_connections
            .fetch_sub(1, Ordering::Relaxed);
    }
}

#[derive(Debug)]
struct Entry {
    counters: Arc<BindingCounters>,
    /// When a report first found the binding outside the snapshot; `None`
    /// while it is routed.
    left_at: Option<Instant>,
}

#[derive(Debug, Default)]
pub(crate) struct BindingStats {
    entries: Mutex<HashMap<String, Entry>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct BindingStatus {
    #[serde(rename = "bindingId")]
    pub(crate) binding_id: String,
    pub(crate) requests: u64,
    #[serde(rename = "activeConnections")]
    pub(crate) active_connections: u64,
    #[serde(rename = "rxBytes")]
    pub(crate) rx_bytes: u64,
    #[serde(rename = "txBytes")]
    pub(crate) tx_bytes: u64,
}

impl BindingStats {
    pub(crate) fn counters(&self, binding_id: &str) -> Arc<BindingCounters> {
        let mut entries = self.lock();
        if let Some(entry) = entries.get(binding_id) {
            return entry.counters.clone();
        }
        let counters = Arc::new(BindingCounters::default());
        entries.insert(
            binding_id.to_string(),
            Entry {
                counters: counters.clone(),
                left_at: None,
            },
        );
        counters
    }

    /// The bindings of the current snapshot (`routed`) plus any binding that
    /// still has an open relay, at most `MAX_REPORTED_BINDINGS` (routed ones
    /// first), sorted by id. Bindings that left the snapshot and are idle
    /// drop out of the report.
    pub(crate) fn report(&self, routed: &HashSet<&str>, now: Instant) -> Vec<BindingStatus> {
        let mut entries = self.lock();
        for binding_id in routed {
            entries
                .entry((*binding_id).to_string())
                .or_insert_with(|| Entry {
                    counters: Arc::default(),
                    left_at: None,
                });
        }
        let mut reported = Vec::new();
        for (binding_id, entry) in entries.iter_mut() {
            let is_routed = routed.contains(binding_id.as_str());
            if is_routed {
                entry.left_at = None;
            } else if entry.left_at.is_none() {
                entry.left_at = Some(now);
            }
            let status = snapshot_counters(binding_id, &entry.counters);
            if is_routed || status.active_connections > 0 {
                reported.push((!is_routed, status));
            }
        }
        forget_longest_gone(&mut entries);
        drop(entries);
        reported.sort_by(|(a_gone, a), (b_gone, b)| {
            a_gone
                .cmp(b_gone)
                .then_with(|| a.binding_id.cmp(&b.binding_id))
        });
        reported.truncate(MAX_REPORTED_BINDINGS);
        let mut reported: Vec<_> = reported.into_iter().map(|(_, status)| status).collect();
        reported.sort_by(|a, b| a.binding_id.cmp(&b.binding_id));
        reported
    }

    #[cfg(test)]
    pub(crate) fn retained(&self) -> usize {
        self.lock().len()
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, Entry>> {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn snapshot_counters(binding_id: &str, counters: &BindingCounters) -> BindingStatus {
    BindingStatus {
        binding_id: binding_id.to_string(),
        requests: counters.requests.load(Ordering::Relaxed),
        active_connections: counters.active_connections.load(Ordering::Relaxed),
        rx_bytes: counters.rx_bytes.load(Ordering::Relaxed),
        tx_bytes: counters.tx_bytes.load(Ordering::Relaxed),
    }
}

/// Keeps the map bounded: idle entries outside the snapshot go first, the
/// longest gone first. Routed entries and open relays are never dropped.
fn forget_longest_gone(entries: &mut HashMap<String, Entry>) {
    if entries.len() <= MAX_RETAINED_BINDINGS {
        return;
    }
    let mut gone: Vec<(Instant, String)> = entries
        .iter()
        .filter_map(|(binding_id, entry)| {
            let left_at = entry.left_at?;
            let idle = entry.counters.active_connections.load(Ordering::Relaxed) == 0;
            idle.then(|| (left_at, binding_id.clone()))
        })
        .collect();
    gone.sort();
    let excess = entries.len() - MAX_RETAINED_BINDINGS;
    for (_, binding_id) in gone.into_iter().take(excess) {
        entries.remove(&binding_id);
    }
}

/// The upstream socket of one exchange: bytes written to it came from the
/// visitor (`rx`), bytes read from it go back to the visitor (`tx`).
pub(crate) struct Metered<S> {
    inner: S,
    counters: Arc<BindingCounters>,
}

impl<S> Metered<S> {
    pub(crate) fn new(inner: S, counters: Arc<BindingCounters>) -> Self {
        Self { inner, counters }
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for Metered<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = buf.filled().len();
        let result = Pin::new(&mut self.inner).poll_read(cx, buf);
        let read = buf.filled().len().saturating_sub(before);
        if read > 0 {
            self.counters
                .tx_bytes
                .fetch_add(read as u64, Ordering::Relaxed);
        }
        result
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Metered<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let result = Pin::new(&mut self.inner).poll_write(cx, buf);
        if let Poll::Ready(Ok(written)) = result {
            self.counters
                .rx_bytes
                .fetch_add(written as u64, Ordering::Relaxed);
        }
        result
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

pub(crate) use proxy_common::instance::new_instance_id;

#[cfg(test)]
#[path = "stats_tests.rs"]
mod tests;
