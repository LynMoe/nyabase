use crate::config::{
    valid_snapshot_stale_after_ms, ProxyConfig, SSH_PROXY_SNAPSHOT_STALE_MAX_MS,
    SSH_PROXY_SNAPSHOT_STALE_MIN_MS,
};
use crate::protocol::{
    BackendEnvelope, ClientEnvelope, ProxyEvent, ProxySnapshot, SshProxyAck,
    SshProxyDisconnectAllCommand, SshProxyDisconnectAllResult, SshProxyMetrics,
    SshProxyPauseAdmitCommand,
};
use crate::runtime::{lock, ProxyRuntime};
use crate::snapshot::SnapshotStore;
use anyhow::{Context, Result};
use futures_util::{Sink, SinkExt, StreamExt};
use proxy_common::backend_tls::validate_backend_ws_url;
use proxy_common::clock::now_ms;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async_tls_with_config, Connector};
use tracing::{debug, info, warn};

pub(crate) const BACKEND_CONTROL_WRITE_TIMEOUT: Duration = Duration::from_secs(5);

/// The Backend's `maxPayload` for this WebSocket; a larger frame closes the
/// link with 1009, so such a frame is never sent.
pub(crate) const BACKEND_CONTROL_MAX_FRAME_BYTES: usize = 1024 * 1024;

/// Encodes the periodic status frame. `SshProxyStatusReport::bounded` keeps it
/// far below the frame limit; should it ever exceed it anyway, the details
/// are dropped (counted as omitted) rather than losing the control link.
pub(crate) fn encode_status_frame(runtime: &ProxyRuntime) -> Result<String> {
    let mut payload = runtime.status_report();
    let encoded = serde_json::to_string(&ClientEnvelope {
        ts: now_ms(),
        kind: "status",
        payload: &payload,
    })?;
    if encoded.len() <= BACKEND_CONTROL_MAX_FRAME_BYTES {
        return Ok(encoded);
    }
    warn!(
        bytes = encoded.len(),
        "SSH proxy status frame over the control limit; sending counts only"
    );
    payload.connections.clear();
    payload.omitted_connections = payload.active_connections;
    Ok(serde_json::to_string(&ClientEnvelope {
        ts: now_ms(),
        kind: "status",
        payload: &payload,
    })?)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ControlMode {
    Empty,
    Authoritative,
    Paused,
}

pub(crate) struct ControlPlane {
    pub(crate) mode: Mutex<ControlMode>,
    pub(crate) epoch: AtomicU64,
    pub(crate) hold_deadline: Mutex<Option<Instant>>,
    pub(crate) admitting: AtomicBool,
    pub(crate) changes: watch::Sender<u64>,
}

impl ControlPlane {
    pub(crate) fn new() -> Self {
        let (changes, _) = watch::channel(0);
        Self {
            mode: Mutex::new(ControlMode::Empty),
            epoch: AtomicU64::new(0),
            hold_deadline: Mutex::new(None),
            admitting: AtomicBool::new(false),
            changes,
        }
    }

    pub(crate) fn subscribe(&self) -> watch::Receiver<u64> {
        self.changes.subscribe()
    }

    pub(crate) fn signal(&self) {
        self.changes
            .send_modify(|revision| *revision = revision.wrapping_add(1));
    }

    pub(crate) fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::Relaxed)
    }

    pub(crate) fn mode(&self) -> ControlMode {
        *lock(&self.mode)
    }

    pub(crate) fn admit(&self) -> bool {
        self.mode() == ControlMode::Authoritative && self.admitting.load(Ordering::Relaxed)
    }

    pub(crate) fn hold_deadline(&self) -> Option<Instant> {
        *lock(&self.hold_deadline)
    }

    pub(crate) fn begin_epoch(&self) -> u64 {
        let epoch = self.epoch.fetch_add(1, Ordering::AcqRel) + 1;
        self.admitting.store(false, Ordering::Release);
        self.signal();
        epoch
    }

    /// Authoritative → Paused arms hold. Already Paused/Empty is idempotent.
    pub(crate) fn pause(&self, hold: Duration) -> bool {
        let mut mode = lock(&self.mode);
        if *mode != ControlMode::Authoritative {
            self.admitting.store(false, Ordering::Release);
            return false;
        }
        *mode = ControlMode::Paused;
        self.admitting.store(false, Ordering::Release);
        *lock(&self.hold_deadline) = Some(Instant::now() + hold);
        drop(mode);
        self.signal();
        true
    }

    pub(crate) fn resume_authoritative(&self) {
        *lock(&self.mode) = ControlMode::Authoritative;
        self.admitting.store(true, Ordering::Release);
        *lock(&self.hold_deadline) = None;
        self.signal();
    }

    pub(crate) fn revoke(&self) {
        *lock(&self.mode) = ControlMode::Empty;
        self.admitting.store(false, Ordering::Release);
        *lock(&self.hold_deadline) = None;
        self.signal();
    }

    pub(crate) fn next_deadline(&self, store: &SnapshotStore) -> Option<Instant> {
        match self.mode() {
            ControlMode::Authoritative if self.admitting.load(Ordering::Relaxed) => {
                store.load().map(|snapshot| snapshot.deadline)
            }
            ControlMode::Paused => self.hold_deadline(),
            ControlMode::Authoritative | ControlMode::Empty => None,
        }
    }
}

pub(crate) async fn run_backend_loop(
    config: ProxyConfig,
    store: Arc<SnapshotStore>,
    runtime: Arc<ProxyRuntime>,
    control: Arc<ControlPlane>,
    mut telemetry_rx: mpsc::Receiver<ProxyEvent>,
) -> Result<()> {
    loop {
        if let Err(error) =
            run_backend_once(&config, &store, &runtime, &control, &mut telemetry_rx).await
        {
            warn!(%error, "SSH proxy backend websocket disconnected");
        }
        pause_control_plane(
            &control,
            &runtime,
            config.control_hold,
            "SSH proxy control plane disconnected",
        )
        .await;
        tokio::time::sleep(config.reconnect_delay).await;
    }
}

pub(crate) async fn run_control_timers(
    store: Arc<SnapshotStore>,
    runtime: Arc<ProxyRuntime>,
    control: Arc<ControlPlane>,
) -> Result<()> {
    let mut store_changes = store.subscribe();
    let mut control_changes = control.subscribe();
    loop {
        let next = control.next_deadline(&store);
        tokio::select! {
            biased;
            changed = store_changes.changed() => {
                changed.context("SSH proxy snapshot lease notifier closed")?;
            }
            changed = control_changes.changed() => {
                changed.context("SSH proxy control-plane notifier closed")?;
            }
            _ = sleep_until_deadline(next), if next.is_some() => {
                match control.mode() {
                    ControlMode::Authoritative if control.admit() => {
                        if let Some((generation, deadline)) = store.current_lease() {
                            if store.expire(generation, deadline) {
                                revoke_control_plane(
                                    &store,
                                    &runtime,
                                    &control,
                                    "SSH proxy snapshot expired",
                                )
                                .await;
                                warn!(generation, "SSH proxy snapshot lease expired");
                            }
                        }
                    }
                    ControlMode::Paused => {
                        if control.hold_deadline().is_some_and(|deadline| Instant::now() >= deadline)
                        {
                            revoke_control_plane(
                                &store,
                                &runtime,
                                &control,
                                "SSH proxy control-plane hold expired",
                            )
                            .await;
                            warn!("SSH proxy control-plane hold expired");
                        }
                    }
                    ControlMode::Authoritative | ControlMode::Empty => {}
                }
            }
        }
    }
}

pub(crate) async fn sleep_until_deadline(deadline: Option<Instant>) {
    let Some(deadline) = deadline else {
        std::future::pending::<()>().await;
        return;
    };
    tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)).await;
}

pub(crate) async fn pause_control_plane(
    control: &ControlPlane,
    runtime: &ProxyRuntime,
    hold: Duration,
    reason: &str,
) {
    let transitioned = control.pause(hold);
    let aborted_pre_auth = runtime.abort_unauthenticated(reason).await;
    if transitioned {
        info!(
            epoch = control.epoch(),
            hold_ms = hold.as_millis() as u64,
            aborted_pre_auth,
            %reason,
            "paused SSH proxy admission"
        );
    }
}

pub(crate) async fn revoke_control_plane(
    store: &SnapshotStore,
    runtime: &ProxyRuntime,
    control: &ControlPlane,
    reason: &str,
) {
    store.clear();
    runtime.clear_snapshot();
    control.revoke();
    runtime.disconnect_invalid(None, reason).await;
}

pub(crate) async fn send_control_frame<S>(
    write: &mut S,
    message: Message,
    timeout: Duration,
) -> Result<()>
where
    S: Sink<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    tokio::time::timeout(timeout, write.send(message))
        .await
        .context("SSH proxy control websocket write timed out")?
        .context("SSH proxy control websocket write failed")?;
    Ok(())
}

pub(crate) async fn run_backend_once(
    config: &ProxyConfig,
    store: &SnapshotStore,
    runtime: &ProxyRuntime,
    control: &ControlPlane,
    telemetry_rx: &mut mpsc::Receiver<ProxyEvent>,
) -> Result<()> {
    validate_backend_ws_url(&config.backend_ws, config.backend_tls.is_some())?;
    let mut request = config.backend_ws.as_str().into_client_request()?;
    request
        .headers_mut()
        .insert("authorization", format!("Bearer {}", config.token).parse()?);
    let connector = config.backend_tls.clone().map(Connector::Rustls);
    let (ws, _) = connect_async_tls_with_config(request, None, false, connector).await?;
    let (mut write, mut read) = ws.split();
    // A new WebSocket is a new generation epoch. Keep the held snapshot so a
    // restarted Backend can publish generation=1 without clearing live Jump.
    control.begin_epoch();
    runtime.mark_backend_connected();
    info!(backend = %config.backend_ws, epoch = control.epoch(), "connected to backend SSH proxy websocket");

    let mut status_tick = tokio::time::interval(config.status_interval);
    status_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut telemetry_closed = false;
    loop {
        tokio::select! {
            _ = status_tick.tick() => {
                send_control_frame(
                    &mut write,
                    Message::Text(encode_status_frame(runtime)?.into()),
                    BACKEND_CONTROL_WRITE_TIMEOUT,
                ).await?;
            }
            frame = read.next() => {
                let Some(frame) = frame else {
                    break;
                };
                let frame = frame?;
                if !frame.is_text() {
                    continue;
                }
                let envelope: BackendEnvelope = serde_json::from_str(frame.to_text()?)?;
                match envelope.kind.as_str() {
                    "snapshot" | "update" => {
                        let snapshot: ProxySnapshot = serde_json::from_value(envelope.payload)?;
                        let generation =
                            install_backend_snapshot(store, runtime, control, snapshot).await?;
                        let ack = ClientEnvelope {
                            ts: now_ms(),
                            kind: "ack",
                            payload: SshProxyAck { generation },
                        };
                        send_control_frame(
                            &mut write,
                            Message::Text(serde_json::to_string(&ack)?.into()),
                            BACKEND_CONTROL_WRITE_TIMEOUT,
                        ).await?;
                    }
                    "pauseAdmit" => {
                        let command: SshProxyPauseAdmitCommand =
                            serde_json::from_value(envelope.payload).unwrap_or(SshProxyPauseAdmitCommand {
                                reason: None,
                            });
                        pause_control_plane(
                            control,
                            runtime,
                            config.control_hold,
                            command.reason.as_deref().unwrap_or("backend pauseAdmit"),
                        )
                        .await;
                    }
                    "disconnectAll" => {
                        let command: SshProxyDisconnectAllCommand = serde_json::from_value(envelope.payload)?;
                        let disconnected = runtime
                            .disconnect_all(command.reason.as_deref().unwrap_or("admin disconnect all"))
                            .await;
                        let envelope = ClientEnvelope {
                            ts: now_ms(),
                            kind: "disconnectAllResult",
                            payload: SshProxyDisconnectAllResult {
                                request_id: command.request_id,
                                disconnected,
                            },
                        };
                        send_control_frame(
                            &mut write,
                            Message::Text(serde_json::to_string(&envelope)?.into()),
                            BACKEND_CONTROL_WRITE_TIMEOUT,
                        ).await?;
                    }
                    other => debug!(kind = other, "ignored backend SSH proxy websocket message"),
                }
            }
            event = telemetry_rx.recv(), if !telemetry_closed => {
                match event {
                    Some(ProxyEvent::Audit(payload)) => {
                        let envelope = ClientEnvelope {
                            ts: now_ms(),
                            kind: "audit",
                            payload,
                        };
                        send_control_frame(
                            &mut write,
                            Message::Text(serde_json::to_string(&envelope)?.into()),
                            BACKEND_CONTROL_WRITE_TIMEOUT,
                        ).await?;
                    }
                    Some(ProxyEvent::Metric(metric)) => {
                        let envelope = ClientEnvelope {
                            ts: now_ms(),
                            kind: "metrics",
                            payload: SshProxyMetrics { metrics: vec![metric] },
                        };
                        send_control_frame(
                            &mut write,
                            Message::Text(serde_json::to_string(&envelope)?.into()),
                            BACKEND_CONTROL_WRITE_TIMEOUT,
                        ).await?;
                    }
                    None => telemetry_closed = true,
                }
            }
        }
    }

    Ok(())
}

pub(crate) async fn install_backend_snapshot(
    store: &SnapshotStore,
    runtime: &ProxyRuntime,
    control: &ControlPlane,
    snapshot: ProxySnapshot,
) -> Result<u64> {
    let generation = snapshot.generation;
    if !valid_snapshot_stale_after_ms(snapshot.stale_after_ms) {
        revoke_control_plane(
            store,
            runtime,
            control,
            "SSH proxy snapshot lease is outside the supported bounds",
        )
        .await;
        anyhow::bail!(
            "SSH proxy snapshot staleAfterMs {} is outside {}..={}",
            snapshot.stale_after_ms,
            SSH_PROXY_SNAPSHOT_STALE_MIN_MS,
            SSH_PROXY_SNAPSHOT_STALE_MAX_MS,
        );
    }
    match store.store(snapshot, control.epoch()) {
        Ok(true) => {
            runtime.mark_snapshot(generation);
            let current = store.load();
            let disconnected_invalid = runtime
                .disconnect_invalid(current.as_deref(), "SSH proxy authorization changed")
                .await;
            control.resume_authoritative();
            info!(
                epoch = control.epoch(),
                generation, disconnected_invalid, "resumed SSH proxy admission"
            );
        }
        Ok(false) => {}
        Err(error) => {
            revoke_control_plane(store, runtime, control, "SSH proxy snapshot was rejected").await;
            return Err(error);
        }
    }
    Ok(generation)
}

#[cfg(test)]
#[path = "control_tests.rs"]
mod tests;
