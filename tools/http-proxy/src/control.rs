use crate::config::{Config, CONTROL_WRITE_DEADLINE};
use crate::protocol::{control_ack_message, Envelope, ProxySnapshot, StatusPayload, StatusReport};
use crate::runtime::Runtime;
use crate::snapshot::{SnapshotLease, SnapshotStore};
use anyhow::{anyhow, Context, Result};
use futures_util::{SinkExt, StreamExt};
use proxy_common::backend_tls::validate_backend_ws_url;
use proxy_common::clock::now_ms;
use proxy_common::control_link::connect_control as connect_control_link;
use std::future::Future;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Error as WebSocketError;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::Connector;
use tracing::warn;

pub(crate) async fn control_loop(
    config: Config,
    store: Arc<SnapshotStore>,
    runtime: Arc<Runtime>,
    mut status_rx: mpsc::Receiver<String>,
) -> Result<()> {
    loop {
        match connect_control(&config, &store, &runtime, &mut status_rx).await {
            Ok(()) => warn!("HTTP proxy control connection closed"),
            Err(error) => warn!(%error, "HTTP proxy control connection failed"),
        }
        // A Backend restart or network blip must not take every site down.
        // Keep serving the last snapshot for the hold window (bounded by the
        // snapshot's own lease, so revocation latency stays bounded too).
        store.hold_after_disconnect(config.control_hold);
        time::sleep(config.reconnect_delay).await;
    }
}

pub(crate) async fn connect_control(
    config: &Config,
    store: &Arc<SnapshotStore>,
    runtime: &Arc<Runtime>,
    status_rx: &mut mpsc::Receiver<String>,
) -> Result<()> {
    validate_backend_ws_url(&config.backend_ws, config.backend_tls.is_some())?;
    let mut request = config.backend_ws.clone().into_client_request()?;
    request
        .headers_mut()
        .insert("Authorization", format!("Bearer {}", config.token).parse()?);
    let connector = config.backend_tls.clone().map(Connector::Rustls);
    let liveness = config.control_liveness;
    let ws = connect_control_link(request, connector, liveness.connect_deadline).await?;
    // Backend restart resets snapshot generations, so each connection is its
    // own monotonicity epoch; its first snapshot replaces the held one.
    store.begin_control_epoch();
    runtime.last_snapshot_generation.store(0, Ordering::Relaxed);
    runtime.last_snapshot_at.store(0, Ordering::Relaxed);
    runtime.connected_at.store(now_ms(), Ordering::Relaxed);
    let (mut write, mut read) = ws.split();
    let mut ping = liveness.ping_timer();
    let mut last_frame = time::Instant::now();
    loop {
        tokio::select! {
            message = time::timeout_at(liveness.read_deadline_after(last_frame), read.next()) => {
                let Ok(message) = message else {
                    return Err(liveness.dead_link_error("HTTP proxy"));
                };
                let Some(message) = message else {
                    return Err(anyhow!("HTTP proxy control connection closed"));
                };
                let message = message?;
                // Any frame (pongs and the Backend's own pings included)
                // proves the link is alive.
                last_frame = time::Instant::now();
                if !message.is_text() { continue; }
                let envelope: Envelope = serde_json::from_str(message.to_text()?)?;
                if envelope.kind == "snapshot" || envelope.kind == "update" {
                    let snapshot: ProxySnapshot = serde_json::from_value(envelope.payload)?;
                    if let Some(generation) = install_snapshot(store, snapshot)? {
                        runtime.last_snapshot_generation.store(generation, Ordering::Relaxed);
                        runtime.last_snapshot_at.store(now_ms(), Ordering::Relaxed);
                        control_write_with_deadline(
                            CONTROL_WRITE_DEADLINE,
                            write.send(Message::Text(control_ack_message(generation).into())),
                        ).await?;
                    }
                }
            }
            _ = ping.tick() => {
                control_write_with_deadline(
                    CONTROL_WRITE_DEADLINE,
                    write.send(Message::Ping(Default::default())),
                ).await?;
            }
            status = status_rx.recv() => {
                let Some(status) = status else {
                    return Err(anyhow!("HTTP proxy status producer exited"));
                };
                control_write_with_deadline(
                    CONTROL_WRITE_DEADLINE,
                    write.send(Message::Text(status.into())),
                ).await?;
            }
        }
    }
}

pub(crate) fn install_snapshot(
    store: &Arc<SnapshotStore>,
    snapshot: ProxySnapshot,
) -> Result<Option<u64>> {
    let Some(lease) = store.store(snapshot)? else {
        return Ok(None);
    };
    Ok(Some(lease.generation))
}

pub(crate) async fn snapshot_lease_loop(store: Arc<SnapshotStore>) -> Result<()> {
    let mut changes = store.subscribe();
    loop {
        let lease = {
            let state = store.lock_state();
            state.current.as_ref().map(|current| SnapshotLease {
                generation: current.generation,
                deadline: current.deadline,
                control_epoch: state.control_epoch.clone(),
            })
        };
        match lease {
            Some(lease) => {
                tokio::select! {
                    biased;
                    changed = changes.changed() => {
                        changed.context("HTTP proxy snapshot lease notifier closed")?;
                    }
                    _ = time::sleep_until(time::Instant::from_std(lease.deadline)) => {
                        store.expire(lease);
                    }
                }
            }
            None => {
                changes
                    .changed()
                    .await
                    .context("HTTP proxy snapshot lease notifier closed")?;
            }
        }
    }
}

pub(crate) async fn control_write_with_deadline<F>(deadline: Duration, write: F) -> Result<()>
where
    F: Future<Output = std::result::Result<(), WebSocketError>>,
{
    match time::timeout(deadline, write).await {
        Ok(result) => result.context("HTTP proxy control write failed"),
        Err(_) => Err(anyhow!("HTTP proxy control write deadline exceeded")),
    }
}

pub(crate) async fn status_loop(
    config: Config,
    runtime: Arc<Runtime>,
    status_tx: mpsc::Sender<String>,
) -> Result<()> {
    let mut interval = time::interval(config.status_interval);
    loop {
        interval.tick().await;
        let last_generation = runtime.last_snapshot_generation.load(Ordering::Relaxed);
        let last_at = runtime.last_snapshot_at.load(Ordering::Relaxed);
        let report = StatusReport {
            ts: now_ms(),
            kind: "status",
            payload: StatusPayload {
                proxy_id: &runtime.proxy_id,
                hostname: runtime.hostname.as_deref(),
                http_listen: &runtime.http_listen,
                https_listen: runtime.https_listen.as_deref(),
                uptime_ms: runtime.started_at.elapsed().as_millis() as u64,
                connected_at: runtime.connected_at.load(Ordering::Relaxed),
                last_snapshot_generation: (last_generation > 0).then_some(last_generation),
                last_snapshot_at: (last_at > 0).then_some(last_at),
                active_connections: runtime.active_connections.load(Ordering::Relaxed),
                total_requests: runtime.total_requests.load(Ordering::Relaxed),
                total_rejected_requests: runtime.total_rejected_requests.load(Ordering::Relaxed),
            },
        };
        let encoded =
            serde_json::to_string(&report).context("failed to encode HTTP proxy status")?;
        status_tx
            .send(encoded)
            .await
            .context("HTTP proxy control loop stopped receiving status")?;
    }
}

#[cfg(test)]
#[path = "control_tests.rs"]
mod tests;
