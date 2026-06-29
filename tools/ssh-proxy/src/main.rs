use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use arc_swap::ArcSwapOption;
use futures_util::{SinkExt, StreamExt};
use russh::client::Msg as ClientMsg;
use russh::keys::key::PrivateKeyWithHashAlg;
use russh::keys::{decode_secret_key, parse_public_key_base64, PrivateKey, PublicKey};
use russh::server::{Auth, Msg as ServerMsg, Session};
use russh::{
    Channel, ChannelId, ChannelMsg, ChannelReadHalf, ChannelWriteHalf, MethodKind, MethodSet, Pty,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::io;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Semaphore};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use tracing::{debug, info, warn};

type TelemetrySender = mpsc::Sender<ProxyEvent>;

#[derive(Clone, Debug)]
struct ProxyConfig {
    backend_ws: String,
    token: String,
    listen: String,
    max_connections: usize,
    reconnect_delay: Duration,
    route_connect_timeout: Duration,
    status_interval: Duration,
}

impl ProxyConfig {
    fn from_env() -> Result<Self> {
        let backend_ws = std::env::var("NYABASE_BACKEND_WS")
            .unwrap_or_else(|_| "ws://127.0.0.1:3000/ws/ssh-proxy".to_string());
        let token = std::env::var("NYABASE_SSH_PROXY_TOKEN")
            .or_else(|_| std::env::var("SSH_PROXY_TOKEN"))
            .context("NYABASE_SSH_PROXY_TOKEN or SSH_PROXY_TOKEN is required")?;
        let listen =
            std::env::var("NYABASE_SSH_LISTEN").unwrap_or_else(|_| "0.0.0.0:2222".to_string());
        let max_connections = std::env::var("NYABASE_SSH_MAX_CONNECTIONS")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(512);
        let reconnect_delay_ms = std::env::var("NYABASE_BACKEND_RECONNECT_MS")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(2_000);
        let route_connect_timeout_ms = std::env::var("NYABASE_SSH_ROUTE_CONNECT_TIMEOUT_MS")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(10_000);
        let status_interval_ms = std::env::var("NYABASE_SSH_STATUS_INTERVAL_MS")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(1_000);

        Ok(Self {
            backend_ws,
            token,
            listen,
            max_connections,
            reconnect_delay: Duration::from_millis(reconnect_delay_ms),
            route_connect_timeout: Duration::from_millis(route_connect_timeout_ms),
            status_interval: Duration::from_millis(status_interval_ms.max(250)),
        })
    }
}

#[derive(Default)]
struct SnapshotStore {
    current: ArcSwapOption<RoutingSnapshot>,
}

impl SnapshotStore {
    fn store(&self, snapshot: ProxySnapshot) {
        let generation = snapshot.generation;
        let route_count = snapshot.routes.len();
        self.current
            .store(Some(Arc::new(RoutingSnapshot::from_snapshot(snapshot))));
        info!(generation, route_count, "installed SSH proxy snapshot");
    }

    fn load(&self) -> Option<Arc<RoutingSnapshot>> {
        self.current.load_full()
    }
}

struct ProxyRuntime {
    proxy_id: String,
    hostname: Option<String>,
    listen: String,
    started_at: Instant,
    backend_connected_at: AtomicU64,
    last_snapshot_generation: AtomicU64,
    last_snapshot_at: AtomicU64,
    total_connections: AtomicU64,
    total_rejected_connections: AtomicU64,
    total_closed_connections: AtomicU64,
    total_bytes_from_client: AtomicU64,
    total_bytes_to_client: AtomicU64,
    connections: Mutex<HashMap<String, Arc<ConnectionState>>>,
    bandwidth: Mutex<BandwidthState>,
}

struct BandwidthState {
    last_ts: u64,
    last_in: u64,
    last_out: u64,
    in_bps: f64,
    out_bps: f64,
}

struct ConnectionState {
    id: String,
    peer: String,
    connected_at: u64,
    authenticated_at: AtomicU64,
    bytes_from_client: AtomicU64,
    bytes_to_client: AtomicU64,
    channels: AtomicUsize,
    login: Mutex<Option<String>>,
    route: Mutex<Option<ConnectionRouteInfo>>,
    server_handle: Mutex<Option<russh::server::Handle>>,
}

#[derive(Clone)]
struct ConnectionRouteInfo {
    username: String,
    server_id: String,
    server_slug: String,
    container_id: String,
    container_name: String,
    runtime_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SshProxyStatusReport {
    proxy_id: String,
    hostname: Option<String>,
    listen: String,
    uptime_ms: u64,
    connected_at: u64,
    last_snapshot_generation: Option<u64>,
    last_snapshot_at: Option<u64>,
    active_connections: usize,
    total_connections: u64,
    total_rejected_connections: u64,
    total_closed_connections: u64,
    total_bytes_from_client: u64,
    total_bytes_to_client: u64,
    bandwidth_in_bps: f64,
    bandwidth_out_bps: f64,
    connections: Vec<SshProxyConnectionInfo>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SshProxyConnectionInfo {
    id: String,
    peer: String,
    username: Option<String>,
    login: Option<String>,
    server_slug: Option<String>,
    server_id: Option<String>,
    container_name: Option<String>,
    container_id: Option<String>,
    runtime_id: Option<String>,
    connected_at: u64,
    authenticated_at: Option<u64>,
    bytes_from_client: u64,
    bytes_to_client: u64,
    channels: usize,
}

impl ProxyRuntime {
    fn new(config: &ProxyConfig) -> Self {
        let hostname = std::env::var("HOSTNAME")
            .ok()
            .filter(|value| !value.is_empty());
        let proxy_id = std::env::var("NYABASE_SSH_PROXY_ID")
            .ok()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| {
                format!(
                    "{}-{}-{}",
                    hostname.as_deref().unwrap_or("ssh-proxy"),
                    std::process::id(),
                    now_ms(),
                )
            });
        let now = now_ms();
        Self {
            proxy_id,
            hostname,
            listen: config.listen.clone(),
            started_at: Instant::now(),
            backend_connected_at: AtomicU64::new(0),
            last_snapshot_generation: AtomicU64::new(0),
            last_snapshot_at: AtomicU64::new(0),
            total_connections: AtomicU64::new(0),
            total_rejected_connections: AtomicU64::new(0),
            total_closed_connections: AtomicU64::new(0),
            total_bytes_from_client: AtomicU64::new(0),
            total_bytes_to_client: AtomicU64::new(0),
            connections: Mutex::new(HashMap::new()),
            bandwidth: Mutex::new(BandwidthState {
                last_ts: now,
                last_in: 0,
                last_out: 0,
                in_bps: 0.0,
                out_bps: 0.0,
            }),
        }
    }

    fn mark_backend_connected(&self) {
        self.backend_connected_at.store(now_ms(), Ordering::Relaxed);
    }

    fn mark_snapshot(&self, generation: u64) {
        self.last_snapshot_generation
            .store(generation, Ordering::Relaxed);
        self.last_snapshot_at.store(now_ms(), Ordering::Relaxed);
    }

    fn record_rejected_connection(&self) {
        self.total_rejected_connections
            .fetch_add(1, Ordering::Relaxed);
    }

    fn register_connection(&self, peer: SocketAddr) -> Arc<ConnectionState> {
        let sequence = self.total_connections.fetch_add(1, Ordering::Relaxed) + 1;
        let connection = Arc::new(ConnectionState::new(sequence, peer));
        lock(&self.connections).insert(connection.id.clone(), connection.clone());
        connection
    }

    fn unregister_connection(&self, id: &str) {
        if let Some(connection) = lock(&self.connections).remove(id) {
            self.total_bytes_from_client.fetch_add(
                connection.bytes_from_client.load(Ordering::Relaxed),
                Ordering::Relaxed,
            );
            self.total_bytes_to_client.fetch_add(
                connection.bytes_to_client.load(Ordering::Relaxed),
                Ordering::Relaxed,
            );
            self.total_closed_connections
                .fetch_add(1, Ordering::Relaxed);
        }
    }

    async fn disconnect_all(&self, reason: &str) -> usize {
        let handles = {
            let connections = lock(&self.connections);
            connections
                .values()
                .filter_map(|connection| connection.server_handle())
                .collect::<Vec<_>>()
        };
        let mut disconnected = 0;
        for handle in handles {
            if handle
                .disconnect(
                    russh::Disconnect::ByApplication,
                    reason.to_string(),
                    String::new(),
                )
                .await
                .is_ok()
            {
                disconnected += 1;
            }
        }
        disconnected
    }

    fn status_report(&self) -> SshProxyStatusReport {
        let mut connections = {
            let connections = lock(&self.connections);
            connections
                .values()
                .map(|connection| connection.snapshot())
                .collect::<Vec<_>>()
        };
        connections.sort_by_key(|connection| connection.connected_at);
        let total_bytes_from_client = connections
            .iter()
            .map(|connection| connection.bytes_from_client)
            .sum::<u64>()
            + self.total_bytes_from_client.load(Ordering::Relaxed);
        let total_bytes_to_client = connections
            .iter()
            .map(|connection| connection.bytes_to_client)
            .sum::<u64>()
            + self.total_bytes_to_client.load(Ordering::Relaxed);
        let (bandwidth_in_bps, bandwidth_out_bps) =
            self.bandwidth(total_bytes_from_client, total_bytes_to_client);
        let last_snapshot_generation =
            nonzero(self.last_snapshot_generation.load(Ordering::Relaxed));
        let last_snapshot_at = nonzero(self.last_snapshot_at.load(Ordering::Relaxed));
        SshProxyStatusReport {
            proxy_id: self.proxy_id.clone(),
            hostname: self.hostname.clone(),
            listen: self.listen.clone(),
            uptime_ms: self.started_at.elapsed().as_millis() as u64,
            connected_at: self.backend_connected_at.load(Ordering::Relaxed),
            last_snapshot_generation,
            last_snapshot_at,
            active_connections: connections.len(),
            total_connections: self.total_connections.load(Ordering::Relaxed),
            total_rejected_connections: self.total_rejected_connections.load(Ordering::Relaxed),
            total_closed_connections: self.total_closed_connections.load(Ordering::Relaxed),
            total_bytes_from_client,
            total_bytes_to_client,
            bandwidth_in_bps,
            bandwidth_out_bps,
            connections,
        }
    }

    fn bandwidth(&self, total_in: u64, total_out: u64) -> (f64, f64) {
        let now = now_ms();
        let mut state = lock(&self.bandwidth);
        let elapsed_ms = now.saturating_sub(state.last_ts);
        if elapsed_ms > 0 {
            state.in_bps =
                total_in.saturating_sub(state.last_in) as f64 * 1000.0 / elapsed_ms as f64;
            state.out_bps =
                total_out.saturating_sub(state.last_out) as f64 * 1000.0 / elapsed_ms as f64;
            state.last_ts = now;
            state.last_in = total_in;
            state.last_out = total_out;
        }
        (state.in_bps, state.out_bps)
    }
}

impl ConnectionState {
    fn new(sequence: u64, peer: SocketAddr) -> Self {
        Self {
            id: format!("conn-{sequence}"),
            peer: peer.to_string(),
            connected_at: now_ms(),
            authenticated_at: AtomicU64::new(0),
            bytes_from_client: AtomicU64::new(0),
            bytes_to_client: AtomicU64::new(0),
            channels: AtomicUsize::new(0),
            login: Mutex::new(None),
            route: Mutex::new(None),
            server_handle: Mutex::new(None),
        }
    }

    fn set_server_handle(&self, handle: russh::server::Handle) {
        *lock(&self.server_handle) = Some(handle);
    }

    fn server_handle(&self) -> Option<russh::server::Handle> {
        lock(&self.server_handle).clone()
    }

    fn set_authenticated(&self, login: &str, route: &OwnedResolvedRoute) {
        *lock(&self.login) = Some(login.to_string());
        *lock(&self.route) = Some(ConnectionRouteInfo {
            username: route.username.clone(),
            server_id: route.server_id.clone(),
            server_slug: route.server_slug.clone(),
            container_id: route.container_id.clone(),
            container_name: route.container_name.clone(),
            runtime_id: route.runtime_id.clone(),
        });
        self.authenticated_at.store(now_ms(), Ordering::Relaxed);
    }

    fn record_from_client(&self, bytes: usize) {
        self.bytes_from_client
            .fetch_add(bytes as u64, Ordering::Relaxed);
    }

    fn record_to_client(&self, bytes: usize) {
        self.bytes_to_client
            .fetch_add(bytes as u64, Ordering::Relaxed);
    }

    fn channel_opened(&self) {
        self.channels.fetch_add(1, Ordering::Relaxed);
    }

    fn channel_closed(&self) {
        let _ = self
            .channels
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                value.checked_sub(1)
            });
    }

    fn snapshot(&self) -> SshProxyConnectionInfo {
        let route = lock(&self.route).clone();
        let authenticated_at = nonzero(self.authenticated_at.load(Ordering::Relaxed));
        SshProxyConnectionInfo {
            id: self.id.clone(),
            peer: self.peer.clone(),
            username: route.as_ref().map(|route| route.username.clone()),
            login: lock(&self.login).clone(),
            server_slug: route.as_ref().map(|route| route.server_slug.clone()),
            server_id: route.as_ref().map(|route| route.server_id.clone()),
            container_name: route.as_ref().map(|route| route.container_name.clone()),
            container_id: route.as_ref().map(|route| route.container_id.clone()),
            runtime_id: route.as_ref().map(|route| route.runtime_id.clone()),
            connected_at: self.connected_at,
            authenticated_at,
            bytes_from_client: self.bytes_from_client.load(Ordering::Relaxed),
            bytes_to_client: self.bytes_to_client.load(Ordering::Relaxed),
            channels: self.channels.load(Ordering::Relaxed),
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn nonzero(value: u64) -> Option<u64> {
    if value == 0 {
        None
    } else {
        Some(value)
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let config = ProxyConfig::from_env()?;
    let store = Arc::new(SnapshotStore::default());
    let runtime = Arc::new(ProxyRuntime::new(&config));
    let (telemetry_tx, telemetry_rx) = mpsc::channel(4096);

    let ws_config = config.clone();
    let ws_store = store.clone();
    let ws_runtime = runtime.clone();
    tokio::spawn(async move {
        run_backend_loop(ws_config, ws_store, ws_runtime, telemetry_rx).await;
    });

    run_public_listener(config, store, runtime, telemetry_tx).await
}

async fn run_backend_loop(
    config: ProxyConfig,
    store: Arc<SnapshotStore>,
    runtime: Arc<ProxyRuntime>,
    mut telemetry_rx: mpsc::Receiver<ProxyEvent>,
) {
    loop {
        if let Err(error) = run_backend_once(&config, &store, &runtime, &mut telemetry_rx).await {
            warn!(%error, "SSH proxy backend websocket disconnected");
        }
        tokio::time::sleep(config.reconnect_delay).await;
    }
}

async fn run_backend_once(
    config: &ProxyConfig,
    store: &SnapshotStore,
    runtime: &ProxyRuntime,
    telemetry_rx: &mut mpsc::Receiver<ProxyEvent>,
) -> Result<()> {
    let mut request = config.backend_ws.as_str().into_client_request()?;
    request
        .headers_mut()
        .insert("authorization", format!("Bearer {}", config.token).parse()?);
    let (ws, _) = connect_async(request).await?;
    let (mut write, mut read) = ws.split();
    runtime.mark_backend_connected();
    info!(backend = %config.backend_ws, "connected to backend SSH proxy websocket");

    let mut status_tick = tokio::time::interval(config.status_interval);
    status_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut telemetry_closed = false;
    loop {
        tokio::select! {
            _ = status_tick.tick() => {
                let envelope = ClientEnvelope {
                    ts: now_ms(),
                    kind: "status",
                    payload: runtime.status_report(),
                };
                write
                    .send(Message::Text(serde_json::to_string(&envelope)?.into()))
                    .await?;
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
                        let generation = snapshot.generation;
                        store.store(snapshot);
                        runtime.mark_snapshot(generation);
                        let ack = ClientEnvelope {
                            ts: now_ms(),
                            kind: "ack",
                            payload: SshProxyAck { generation },
                        };
                        write
                            .send(Message::Text(serde_json::to_string(&ack)?.into()))
                            .await?;
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
                        write
                            .send(Message::Text(serde_json::to_string(&envelope)?.into()))
                            .await?;
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
                        write
                            .send(Message::Text(serde_json::to_string(&envelope)?.into()))
                            .await?;
                    }
                    Some(ProxyEvent::Metric(metric)) => {
                        let envelope = ClientEnvelope {
                            ts: now_ms(),
                            kind: "metrics",
                            payload: SshProxyMetrics { metrics: vec![metric] },
                        };
                        write
                            .send(Message::Text(serde_json::to_string(&envelope)?.into()))
                            .await?;
                    }
                    None => telemetry_closed = true,
                }
            }
        }
    }

    Ok(())
}

async fn run_public_listener(
    config: ProxyConfig,
    store: Arc<SnapshotStore>,
    runtime: Arc<ProxyRuntime>,
    telemetry: TelemetrySender,
) -> Result<()> {
    let listener = TcpListener::bind(&config.listen).await?;
    let limit = Arc::new(Semaphore::new(config.max_connections));
    info!(listen = %config.listen, "SSH proxy listener started");

    loop {
        let (stream, peer) = listener.accept().await?;
        let permit = match limit.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                warn!(%peer, "connection rejected by global concurrency limit");
                runtime.record_rejected_connection();
                emit_metric(
                    &telemetry,
                    "ssh_proxy_connections_total",
                    vec![("result", "rejected_limit".to_string())],
                    1.0,
                );
                continue;
            }
        };
        let store = store.clone();
        let config = config.clone();
        let runtime = runtime.clone();
        let telemetry = telemetry.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let connection = runtime.register_connection(peer);
            emit_metric(
                &telemetry,
                "ssh_proxy_connections_total",
                vec![("result", "accepted".to_string())],
                1.0,
            );
            if let Err(error) = handle_ssh_connection(
                stream,
                peer,
                store,
                config,
                telemetry.clone(),
                connection.clone(),
            )
            .await
            {
                debug!(%peer, %error, "SSH connection closed");
                emit_metric(
                    &telemetry,
                    "ssh_proxy_connections_total",
                    vec![("result", "closed_error".to_string())],
                    1.0,
                );
            }
            runtime.unregister_connection(&connection.id);
        });
    }
}

async fn handle_ssh_connection(
    stream: TcpStream,
    peer: SocketAddr,
    store: Arc<SnapshotStore>,
    config: ProxyConfig,
    telemetry: TelemetrySender,
    connection: Arc<ConnectionState>,
) -> Result<()> {
    let snapshot = store.load().context("no routing snapshot is installed")?;
    if !snapshot.is_fresh() {
        anyhow::bail!("routing snapshot {} is stale", snapshot.generation);
    }
    let host_key = snapshot
        .host_private_key()
        .context("failed to parse proxy host key from snapshot")?;
    let mut methods = MethodSet::empty();
    methods.push(MethodKind::PublicKey);
    let server_config = Arc::new(russh::server::Config {
        auth_rejection_time: Duration::from_millis(250),
        auth_rejection_time_initial: Some(Duration::from_millis(0)),
        methods,
        keys: vec![host_key],
        nodelay: true,
        inactivity_timeout: Some(Duration::from_secs(600)),
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        ..Default::default()
    });
    let handler = ProxySshSession::new(snapshot, config, peer, telemetry, connection);
    let session = russh::server::run_stream(server_config, stream, handler).await?;
    session.await?;
    Ok(())
}

#[derive(Debug, Deserialize)]
struct BackendEnvelope {
    kind: String,
    payload: serde_json::Value,
}

#[derive(Debug, Serialize)]
struct ClientEnvelope<T> {
    ts: u64,
    kind: &'static str,
    payload: T,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SshProxyAck {
    generation: u64,
}

#[derive(Debug, Serialize)]
struct SshProxyMetrics {
    metrics: Vec<SshProxyMetric>,
}

#[derive(Clone, Debug, Serialize)]
struct SshProxyMetric {
    name: String,
    labels: HashMap<String, String>,
    value: f64,
    ts: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SshProxyAuditEvent {
    #[serde(skip_serializing_if = "Option::is_none")]
    user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    container_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    server_id: Option<String>,
    action: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    ts: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SshProxyDisconnectAllCommand {
    request_id: String,
    reason: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SshProxyDisconnectAllResult {
    request_id: String,
    disconnected: usize,
}

#[derive(Debug)]
enum ProxyEvent {
    Metric(SshProxyMetric),
    Audit(SshProxyAuditEvent),
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProxySnapshot {
    generation: u64,
    stale_after_ms: u64,
    host_key: ProxyHostKey,
    users: Vec<ProxyUser>,
    servers: Vec<ProxyServer>,
    images: Vec<ProxyImage>,
    containers: Vec<ProxyContainer>,
    routes: Vec<ProxyRoute>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct ProxyHostKey {
    private_key: String,
    public_key: String,
    fingerprint: String,
    generation: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct ProxyUser {
    id: String,
    username: String,
    status: String,
    public_keys: Vec<String>,
    internal_private_key: String,
    internal_public_key: String,
    internal_key_fingerprint: String,
    internal_key_generation: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[allow(dead_code)]
struct ProxyServer {
    id: String,
    slug: String,
    name: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProxyImage {
    id: String,
    disable_ssh: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProxyContainer {
    id: String,
    owner_id: String,
    server_id: String,
    image_id: String,
    name: String,
    deleted: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct ProxyRoute {
    container_id: String,
    server_id: String,
    runtime_id: String,
    macvlan_ip: Option<String>,
    runtime_status: String,
    ssh_status: String,
    applied_internal_key_generation: Option<u64>,
    container_host_key_fingerprint: Option<String>,
    observed_at: String,
}

#[derive(Debug)]
#[allow(dead_code)]
struct RoutingSnapshot {
    generation: u64,
    received_at: Instant,
    stale_after: Duration,
    host_key: ProxyHostKey,
    users: Vec<ProxyUser>,
    servers_by_id: HashMap<String, ProxyServer>,
    images_by_id: HashMap<String, ProxyImage>,
    containers: Vec<ProxyContainer>,
    routes_by_container_id: HashMap<String, ProxyRoute>,
}

impl RoutingSnapshot {
    fn from_snapshot(snapshot: ProxySnapshot) -> Self {
        Self {
            generation: snapshot.generation,
            received_at: Instant::now(),
            stale_after: Duration::from_millis(snapshot.stale_after_ms),
            host_key: snapshot.host_key,
            users: snapshot.users,
            servers_by_id: snapshot
                .servers
                .into_iter()
                .map(|server| (server.id.clone(), server))
                .collect(),
            images_by_id: snapshot
                .images
                .into_iter()
                .map(|image| (image.id.clone(), image))
                .collect(),
            containers: snapshot.containers,
            routes_by_container_id: snapshot
                .routes
                .into_iter()
                .map(|route| (route.container_id.clone(), route))
                .collect(),
        }
    }

    fn is_fresh(&self) -> bool {
        self.received_at.elapsed() <= self.stale_after
    }

    fn host_private_key(&self) -> Option<PrivateKey> {
        decode_secret_key(&self.host_key.private_key, None).ok()
    }

    fn resolve_login(&self, login: &str) -> RouteResolution<'_> {
        let parsed = match ParsedLogin::parse(login) {
            Some(parsed) => parsed,
            None => return RouteResolution::Rejected(RejectReason::InvalidLogin),
        };

        let user = match self
            .users
            .iter()
            .find(|user| user.username.eq_ignore_ascii_case(&parsed.username))
        {
            Some(user) if user.status == "active" => user,
            Some(_) => return RouteResolution::Rejected(RejectReason::UserDisabled),
            None => return RouteResolution::Rejected(RejectReason::UserNotFound),
        };

        if let Some(server_slug) = &parsed.server_slug {
            let exists = self
                .servers_by_id
                .values()
                .any(|server| server.slug.eq_ignore_ascii_case(server_slug));
            if !exists {
                return RouteResolution::Rejected(RejectReason::ServerNotFound);
            }
        }

        let mut candidates = Vec::new();
        for container in &self.containers {
            if container.deleted || container.owner_id != user.id {
                continue;
            }
            if !container.name.eq_ignore_ascii_case(&parsed.container_name) {
                continue;
            }
            if self
                .images_by_id
                .get(&container.image_id)
                .map(|image| image.disable_ssh)
                .unwrap_or(true)
            {
                continue;
            }
            let Some(server) = self.servers_by_id.get(&container.server_id) else {
                continue;
            };
            if let Some(server_slug) = &parsed.server_slug {
                if !server.slug.eq_ignore_ascii_case(server_slug) {
                    continue;
                }
            }
            let Some(route) = self.routes_by_container_id.get(&container.id) else {
                continue;
            };
            if !route.is_active() {
                continue;
            }
            candidates.push(ResolvedRoute {
                login: parsed.clone(),
                user,
                server,
                container,
                route,
            });
        }

        match candidates.len() {
            0 => RouteResolution::Rejected(RejectReason::RouteNotFound),
            1 => RouteResolution::Accepted(candidates.remove(0)),
            _ if parsed.server_slug.is_none() => {
                RouteResolution::Rejected(RejectReason::AmbiguousContainer)
            }
            _ => RouteResolution::Accepted(candidates.remove(0)),
        }
    }

    fn public_key_allowed(&self, login: &str, public_key: &PublicKey) -> bool {
        let RouteResolution::Accepted(route) = self.resolve_login(login) else {
            return false;
        };
        route
            .user
            .public_keys
            .iter()
            .any(|key| parse_authorized_key(key).is_some_and(|allowed| allowed == *public_key))
    }
}

impl ProxyRoute {
    fn is_active(&self) -> bool {
        self.macvlan_ip.as_deref().is_some_and(|ip| !ip.is_empty())
            && self.runtime_status == "running"
            && self.ssh_status == "running"
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ParsedLogin {
    username: String,
    server_slug: Option<String>,
    container_name: String,
}

impl ParsedLogin {
    fn parse(value: &str) -> Option<Self> {
        let parts = value
            .trim()
            .to_lowercase()
            .split('.')
            .filter(|part| !part.is_empty())
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();
        match parts.as_slice() {
            [username, container_name] => Some(Self {
                username: username.clone(),
                server_slug: None,
                container_name: container_name.clone(),
            }),
            [username, server_slug, container_name] => Some(Self {
                username: username.clone(),
                server_slug: Some(server_slug.clone()),
                container_name: container_name.clone(),
            }),
            _ => None,
        }
    }
}

#[derive(Debug)]
#[allow(dead_code)]
struct ResolvedRoute<'a> {
    login: ParsedLogin,
    user: &'a ProxyUser,
    server: &'a ProxyServer,
    container: &'a ProxyContainer,
    route: &'a ProxyRoute,
}

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
enum RejectReason {
    #[error("invalid login")]
    InvalidLogin,
    #[error("user not found")]
    UserNotFound,
    #[error("user disabled")]
    UserDisabled,
    #[error("server not found")]
    ServerNotFound,
    #[error("route not found")]
    RouteNotFound,
    #[error("ambiguous container")]
    AmbiguousContainer,
}

impl RejectReason {
    fn code(self) -> &'static str {
        match self {
            Self::InvalidLogin => "invalid_login",
            Self::UserNotFound => "user_not_found",
            Self::UserDisabled => "user_disabled",
            Self::ServerNotFound => "server_not_found",
            Self::RouteNotFound => "route_not_found",
            Self::AmbiguousContainer => "ambiguous_container",
        }
    }
}

#[derive(Debug)]
enum RouteResolution<'a> {
    Accepted(ResolvedRoute<'a>),
    Rejected(RejectReason),
}

struct ProxySshSession {
    snapshot: Arc<RoutingSnapshot>,
    config: ProxyConfig,
    peer: SocketAddr,
    telemetry: TelemetrySender,
    connection: Arc<ConnectionState>,
    authenticated_login: Option<String>,
    resolved_route: Option<OwnedResolvedRoute>,
    channels: HashMap<ChannelId, UpstreamChannel>,
    remote_forwards: HashMap<ForwardKey, russh::client::Handle<ContainerClient>>,
}

#[derive(Clone, Debug)]
struct OwnedResolvedRoute {
    user_id: String,
    username: String,
    server_id: String,
    server_slug: String,
    container_id: String,
    container_name: String,
    runtime_id: String,
    macvlan_ip: String,
    internal_private_key: String,
}

struct UpstreamChannel {
    upstream_handle: russh::client::Handle<ContainerClient>,
    upstream_write: Arc<ChannelWriteHalf<ClientMsg>>,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct ForwardKey {
    address: String,
    port: u32,
}

struct ContainerClient {
    client_handle: russh::server::Handle,
    peer: SocketAddr,
    connection: Arc<ConnectionState>,
}

impl ProxySshSession {
    fn new(
        snapshot: Arc<RoutingSnapshot>,
        config: ProxyConfig,
        peer: SocketAddr,
        telemetry: TelemetrySender,
        connection: Arc<ConnectionState>,
    ) -> Self {
        Self {
            snapshot,
            config,
            peer,
            telemetry,
            connection,
            authenticated_login: None,
            resolved_route: None,
            channels: HashMap::new(),
            remote_forwards: HashMap::new(),
        }
    }

    fn route_for_login(&self, login: &str) -> Result<OwnedResolvedRoute, RejectReason> {
        match self.snapshot.resolve_login(login) {
            RouteResolution::Accepted(route) => Ok(OwnedResolvedRoute {
                user_id: route.user.id.clone(),
                username: route.user.username.clone(),
                server_id: route.server.id.clone(),
                server_slug: route.server.slug.clone(),
                container_id: route.container.id.clone(),
                container_name: route.container.name.clone(),
                runtime_id: route.route.runtime_id.clone(),
                macvlan_ip: route.route.macvlan_ip.clone().unwrap_or_default(),
                internal_private_key: route.user.internal_private_key.clone(),
            }),
            RouteResolution::Rejected(reason) => Err(reason),
        }
    }

    async fn connect_upstream(
        &self,
        client_handle: russh::server::Handle,
    ) -> Result<Option<russh::client::Handle<ContainerClient>>> {
        let Some(route) = self.resolved_route.clone() else {
            return Ok(None);
        };
        let private_key = decode_secret_key(&route.internal_private_key, None)
            .context("failed to parse internal private key")?;
        let address = format!("{}:22", route.macvlan_ip);
        let client_config = Arc::new(russh::client::Config {
            inactivity_timeout: Some(Duration::from_secs(600)),
            keepalive_interval: Some(Duration::from_secs(30)),
            ..Default::default()
        });
        let client_handler = ContainerClient {
            client_handle,
            peer: self.peer,
            connection: self.connection.clone(),
        };
        let mut upstream = tokio::time::timeout(
            self.config.route_connect_timeout,
            russh::client::connect(client_config, address, client_handler),
        )
        .await
        .context("timed out connecting to container SSH route")??;
        let auth = upstream
            .authenticate_publickey(
                "root",
                PrivateKeyWithHashAlg::new(
                    Arc::new(private_key),
                    upstream.best_supported_rsa_hash().await?.flatten(),
                ),
            )
            .await?;
        if !auth.success() {
            anyhow::bail!("container internal key authentication failed");
        }
        debug!(
            peer = %self.peer,
            username = %route.username,
            container_id = %route.container_id,
            container_name = %route.container_name,
            runtime_id = %route.runtime_id,
            "authenticated upstream container SSH route"
        );
        Ok(Some(upstream))
    }

    async fn open_upstream_channel(
        &mut self,
        channel_id: ChannelId,
        session: &mut Session,
    ) -> Result<Option<Arc<ChannelWriteHalf<ClientMsg>>>> {
        if let Some(existing) = self.channels.get(&channel_id) {
            return Ok(Some(existing.upstream_write.clone()));
        }

        let Some(upstream) = self.connect_upstream(session.handle()).await? else {
            let _ = session.handle().close(channel_id).await;
            return Ok(None);
        };
        let channel = upstream.channel_open_session().await?;
        let upstream_channel_id = channel.id();
        let (upstream_read, upstream_write) = channel.split();
        let upstream_write = Arc::new(upstream_write);
        spawn_upstream_relay(
            channel_id,
            session.handle(),
            upstream_read,
            self.connection.clone(),
        );
        self.channels.insert(
            channel_id,
            UpstreamChannel {
                upstream_handle: upstream,
                upstream_write: upstream_write.clone(),
            },
        );
        debug!(
            peer = %self.peer,
            channel = ?channel_id,
            upstream_channel = ?upstream_channel_id,
            "opened upstream SSH channel"
        );
        Ok(Some(upstream_write))
    }

    fn upstream_for(&self, channel_id: ChannelId) -> Option<Arc<ChannelWriteHalf<ClientMsg>>> {
        self.channels
            .get(&channel_id)
            .map(|channel| channel.upstream_write.clone())
    }

    fn emit_login_audit(
        &self,
        login: &str,
        route: Option<&OwnedResolvedRoute>,
        ok: bool,
        reason: Option<&str>,
    ) {
        emit_audit(
            &self.telemetry,
            SshProxyAuditEvent {
                user_id: route.map(|route| route.user_id.clone()),
                username: Some(
                    route
                        .map(|route| route.username.clone())
                        .unwrap_or_else(|| login.to_string()),
                ),
                container_id: route.map(|route| route.container_id.clone()),
                server_id: route.map(|route| route.server_id.clone()),
                action: "login".to_string(),
                ok,
                reason: reason.map(ToOwned::to_owned),
                ts: now_ms(),
            },
        );
    }
}

impl russh::server::Handler for ProxySshSession {
    type Error = anyhow::Error;

    async fn auth_succeeded(&mut self, session: &mut Session) -> Result<(), Self::Error> {
        self.connection.set_server_handle(session.handle());
        Ok(())
    }

    async fn auth_none(&mut self, _user: &str) -> Result<Auth, Self::Error> {
        Ok(Auth::reject())
    }

    async fn auth_password(&mut self, _user: &str, _password: &str) -> Result<Auth, Self::Error> {
        Ok(Auth::reject())
    }

    async fn auth_publickey_offered(
        &mut self,
        user: &str,
        public_key: &PublicKey,
    ) -> Result<Auth, Self::Error> {
        if self.snapshot.public_key_allowed(user, public_key) {
            Ok(Auth::Accept)
        } else {
            Ok(Auth::reject())
        }
    }

    async fn auth_publickey(
        &mut self,
        user: &str,
        public_key: &PublicKey,
    ) -> Result<Auth, Self::Error> {
        if !self.snapshot.public_key_allowed(user, public_key) {
            warn!(peer = %self.peer, login = user, "SSH proxy public key rejected");
            self.emit_login_audit(user, None, false, Some("public_key_rejected"));
            return Ok(Auth::reject());
        }
        match self.route_for_login(user) {
            Ok(route) => {
                info!(
                    peer = %self.peer,
                    login = user,
                    container_id = %route.container_id,
                    server_slug = %route.server_slug,
                    "SSH proxy login authenticated"
                );
                self.emit_login_audit(user, Some(&route), true, None);
                self.connection.set_authenticated(user, &route);
                emit_metric(
                    &self.telemetry,
                    "ssh_proxy_logins_total",
                    vec![
                        ("result", "accepted".to_string()),
                        ("server_slug", route.server_slug.clone()),
                    ],
                    1.0,
                );
                self.authenticated_login = Some(user.to_string());
                self.resolved_route = Some(route);
                Ok(Auth::Accept)
            }
            Err(reason) => {
                warn!(peer = %self.peer, login = user, %reason, "SSH proxy route rejected");
                self.emit_login_audit(user, None, false, Some(reason.code()));
                emit_metric(
                    &self.telemetry,
                    "ssh_proxy_logins_total",
                    vec![("result", reason.code().to_string())],
                    1.0,
                );
                Ok(Auth::reject())
            }
        }
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<ServerMsg>,
        session: &mut Session,
    ) -> Result<bool, Self::Error> {
        let channel_id = channel.id();
        match self.open_upstream_channel(channel_id, session).await {
            Ok(Some(_upstream)) => {
                self.connection.channel_opened();
                Ok(true)
            }
            Ok(None) => Ok(false),
            Err(error) => {
                warn!(peer = %self.peer, channel = ?channel_id, %error, "failed to open upstream SSH channel");
                emit_metric(
                    &self.telemetry,
                    "ssh_proxy_channels_total",
                    vec![
                        ("kind", "session".to_string()),
                        ("result", "open_failed".to_string()),
                    ],
                    1.0,
                );
                Ok(false)
            }
        }
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        term: &str,
        col_width: u32,
        row_height: u32,
        pix_width: u32,
        pix_height: u32,
        modes: &[(Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let Some(upstream) = self.open_upstream_channel(channel, session).await? else {
            session.channel_failure(channel)?;
            return Ok(());
        };
        upstream
            .request_pty(
                true, term, col_width, row_height, pix_width, pix_height, modes,
            )
            .await?;
        Ok(())
    }

    async fn env_request(
        &mut self,
        channel: ChannelId,
        variable_name: &str,
        variable_value: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let Some(upstream) = self.open_upstream_channel(channel, session).await? else {
            session.channel_failure(channel)?;
            return Ok(());
        };
        upstream
            .set_env(true, variable_name, variable_value)
            .await?;
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let Some(upstream) = self.open_upstream_channel(channel, session).await? else {
            session.channel_failure(channel)?;
            return Ok(());
        };
        upstream.request_shell(true).await?;
        Ok(())
    }

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let Some(upstream) = self.open_upstream_channel(channel, session).await? else {
            session.channel_failure(channel)?;
            return Ok(());
        };
        upstream.exec(true, data.to_vec()).await?;
        Ok(())
    }

    async fn subsystem_request(
        &mut self,
        channel: ChannelId,
        name: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let Some(upstream) = self.open_upstream_channel(channel, session).await? else {
            session.channel_failure(channel)?;
            return Ok(());
        };
        upstream.request_subsystem(true, name).await?;
        Ok(())
    }

    async fn window_change_request(
        &mut self,
        channel: ChannelId,
        col_width: u32,
        row_height: u32,
        pix_width: u32,
        pix_height: u32,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        if let Some(upstream) = self.upstream_for(channel) {
            upstream
                .window_change(col_width, row_height, pix_width, pix_height)
                .await?;
        }
        Ok(())
    }

    async fn agent_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<bool, Self::Error> {
        let Some(upstream) = self.open_upstream_channel(channel, session).await? else {
            session.channel_failure(channel)?;
            return Ok(false);
        };
        upstream.agent_forward(true).await?;
        Ok(true)
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.connection.record_from_client(data.len());
        if let Some(upstream) = self.upstream_for(channel) {
            let _ = upstream.data_bytes(data.to_vec()).await;
        }
        Ok(())
    }

    async fn extended_data(
        &mut self,
        channel: ChannelId,
        code: u32,
        data: &[u8],
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.connection.record_from_client(data.len());
        if let Some(upstream) = self.upstream_for(channel) {
            upstream.extended_data_bytes(code, data.to_vec()).await?;
        }
        Ok(())
    }

    async fn channel_eof(
        &mut self,
        channel: ChannelId,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        if let Some(upstream) = self.upstream_for(channel) {
            let _ = upstream.eof().await;
        }
        Ok(())
    }

    async fn channel_close(
        &mut self,
        channel: ChannelId,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        if let Some(upstream) = self.channels.remove(&channel) {
            self.connection.channel_closed();
            let _ = upstream.upstream_write.close().await;
            let _ = upstream
                .upstream_handle
                .disconnect(
                    russh::Disconnect::ByApplication,
                    "client channel closed",
                    "",
                )
                .await;
        }
        Ok(())
    }

    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<ServerMsg>,
        host_to_connect: &str,
        port_to_connect: u32,
        originator_address: &str,
        originator_port: u32,
        session: &mut Session,
    ) -> Result<bool, Self::Error> {
        let peer = self.peer;
        let Some(upstream) = self.connect_upstream(session.handle()).await? else {
            return Ok(false);
        };
        let upstream_channel = match upstream
            .channel_open_direct_tcpip(
                host_to_connect.to_string(),
                port_to_connect,
                originator_address.to_string(),
                originator_port,
            )
            .await
        {
            Ok(channel) => channel,
            Err(error) => {
                warn!(
                    %peer,
                    target = %format!("{host_to_connect}:{port_to_connect}"),
                    originator = %format!("{originator_address}:{originator_port}"),
                    %error,
                    "upstream direct-tcpip channel rejected"
                );
                let _ = upstream
                    .disconnect(
                        russh::Disconnect::ByApplication,
                        "direct-tcpip rejected",
                        "",
                    )
                    .await;
                emit_metric(
                    &self.telemetry,
                    "ssh_proxy_channels_total",
                    vec![
                        ("kind", "direct_tcpip".to_string()),
                        ("result", "open_failed".to_string()),
                    ],
                    1.0,
                );
                return Ok(false);
            }
        };
        emit_metric(
            &self.telemetry,
            "ssh_proxy_channels_total",
            vec![
                ("kind", "direct_tcpip".to_string()),
                ("result", "opened".to_string()),
            ],
            1.0,
        );
        spawn_channel_bridge(
            peer,
            "direct-tcpip",
            channel,
            upstream_channel,
            Some(upstream),
            self.connection.clone(),
        );
        Ok(true)
    }

    async fn tcpip_forward(
        &mut self,
        address: &str,
        port: &mut u32,
        session: &mut Session,
    ) -> Result<bool, Self::Error> {
        let peer = self.peer;
        let requested_port = *port;
        let Some(upstream) = self.connect_upstream(session.handle()).await? else {
            return Ok(false);
        };
        match upstream
            .tcpip_forward(address.to_string(), requested_port)
            .await
        {
            Ok(returned_port) => {
                let actual_port = if requested_port == 0 {
                    returned_port
                } else {
                    requested_port
                };
                if actual_port == 0 {
                    warn!(%peer, %address, requested_port, returned_port, "upstream remote forward returned no usable port");
                    let _ = upstream
                        .disconnect(
                            russh::Disconnect::ByApplication,
                            "remote forward unusable",
                            "",
                        )
                        .await;
                    return Ok(false);
                }
                *port = actual_port;
                let key = ForwardKey {
                    address: address.to_string(),
                    port: actual_port,
                };
                if let Some(old) = self.remote_forwards.insert(key, upstream) {
                    let _ = old
                        .disconnect(
                            russh::Disconnect::ByApplication,
                            "remote forward replaced",
                            "",
                        )
                        .await;
                }
                info!(%peer, %address, port = actual_port, "remote tcpip forward enabled");
                emit_metric(
                    &self.telemetry,
                    "ssh_proxy_forwards_total",
                    vec![
                        ("kind", "remote_tcpip".to_string()),
                        ("result", "enabled".to_string()),
                    ],
                    1.0,
                );
                Ok(true)
            }
            Err(error) => {
                warn!(%peer, %address, requested_port, %error, "upstream remote tcpip forward rejected");
                let _ = upstream
                    .disconnect(
                        russh::Disconnect::ByApplication,
                        "remote forward rejected",
                        "",
                    )
                    .await;
                emit_metric(
                    &self.telemetry,
                    "ssh_proxy_forwards_total",
                    vec![
                        ("kind", "remote_tcpip".to_string()),
                        ("result", "rejected".to_string()),
                    ],
                    1.0,
                );
                Ok(false)
            }
        }
    }

    async fn cancel_tcpip_forward(
        &mut self,
        address: &str,
        port: u32,
        _session: &mut Session,
    ) -> Result<bool, Self::Error> {
        let key = ForwardKey {
            address: address.to_string(),
            port,
        };
        let Some(upstream) = self.remote_forwards.remove(&key) else {
            return Ok(false);
        };
        match upstream
            .cancel_tcpip_forward(address.to_string(), port)
            .await
        {
            Ok(()) => {
                emit_metric(
                    &self.telemetry,
                    "ssh_proxy_forwards_total",
                    vec![
                        ("kind", "remote_tcpip".to_string()),
                        ("result", "cancelled".to_string()),
                    ],
                    1.0,
                );
                Ok(true)
            }
            Err(error) => {
                warn!(peer = %self.peer, %address, port, %error, "failed to cancel upstream remote tcpip forward");
                emit_metric(
                    &self.telemetry,
                    "ssh_proxy_forwards_total",
                    vec![
                        ("kind", "remote_tcpip".to_string()),
                        ("result", "cancel_failed".to_string()),
                    ],
                    1.0,
                );
                Ok(false)
            }
        }
    }
}

impl russh::client::Handler for ContainerClient {
    type Error = anyhow::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<ClientMsg>,
        connected_address: &str,
        connected_port: u32,
        originator_address: &str,
        originator_port: u32,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        let client_channel = match self
            .client_handle
            .channel_open_forwarded_tcpip(
                connected_address.to_string(),
                connected_port,
                originator_address.to_string(),
                originator_port,
            )
            .await
        {
            Ok(channel) => channel,
            Err(error) => {
                warn!(
                    peer = %self.peer,
                    connected = %format!("{connected_address}:{connected_port}"),
                    originator = %format!("{originator_address}:{originator_port}"),
                    %error,
                    "failed to open external forwarded-tcpip channel"
                );
                let _ = channel.close().await;
                return Ok(());
            }
        };
        spawn_channel_bridge(
            self.peer,
            "remote-forward",
            client_channel,
            channel,
            None,
            self.connection.clone(),
        );
        Ok(())
    }

    async fn server_channel_open_agent_forward(
        &mut self,
        channel: Channel<ClientMsg>,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        let client_channel = match self.client_handle.channel_open_agent().await {
            Ok(channel) => channel,
            Err(error) => {
                warn!(peer = %self.peer, %error, "failed to open external agent-forward channel");
                let _ = channel.close().await;
                return Ok(());
            }
        };
        spawn_channel_bridge(
            self.peer,
            "agent-forward",
            client_channel,
            channel,
            None,
            self.connection.clone(),
        );
        Ok(())
    }
}

fn emit_metric(
    telemetry: &TelemetrySender,
    name: impl Into<String>,
    labels: Vec<(&'static str, String)>,
    value: f64,
) {
    let metric = SshProxyMetric {
        name: name.into(),
        labels: labels
            .into_iter()
            .map(|(key, value)| (key.to_string(), value))
            .collect(),
        value,
        ts: now_ms(),
    };
    if telemetry.try_send(ProxyEvent::Metric(metric)).is_err() {
        debug!("SSH proxy telemetry metric dropped");
    }
}

fn emit_audit(telemetry: &TelemetrySender, event: SshProxyAuditEvent) {
    if telemetry.try_send(ProxyEvent::Audit(event)).is_err() {
        debug!("SSH proxy telemetry audit event dropped");
    }
}

fn spawn_channel_bridge(
    peer: SocketAddr,
    kind: &'static str,
    client_channel: Channel<ServerMsg>,
    upstream_channel: Channel<ClientMsg>,
    upstream_handle: Option<russh::client::Handle<ContainerClient>>,
    connection: Arc<ConnectionState>,
) {
    tokio::spawn(async move {
        let mut client_stream = client_channel.into_stream();
        let mut upstream_stream = upstream_channel.into_stream();
        match io::copy_bidirectional(&mut client_stream, &mut upstream_stream).await {
            Ok((from_client, to_client)) => {
                connection.record_from_client(from_client as usize);
                connection.record_to_client(to_client as usize);
            }
            Err(error) => {
                debug!(%peer, kind, %error, "SSH channel bridge ended with error");
            }
        }
        if let Some(upstream_handle) = upstream_handle {
            let _ = upstream_handle
                .disconnect(
                    russh::Disconnect::ByApplication,
                    "channel bridge closed",
                    "",
                )
                .await;
        }
    });
}

fn parse_authorized_key(text: &str) -> Option<PublicKey> {
    text.split_whitespace()
        .find_map(|part| parse_public_key_base64(part).ok())
}

fn spawn_upstream_relay(
    client_channel_id: ChannelId,
    client_handle: russh::server::Handle,
    mut upstream: ChannelReadHalf,
    connection: Arc<ConnectionState>,
) {
    tokio::spawn(async move {
        while let Some(message) = upstream.wait().await {
            match message {
                ChannelMsg::Data { data } => {
                    connection.record_to_client(data.len());
                    if client_handle
                        .data(client_channel_id, data.to_vec())
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                ChannelMsg::ExtendedData { ext, data } => {
                    connection.record_to_client(data.len());
                    if client_handle
                        .extended_data(client_channel_id, ext, data.to_vec())
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                ChannelMsg::ExitStatus { exit_status } => {
                    let _ = client_handle
                        .exit_status_request(client_channel_id, exit_status)
                        .await;
                }
                ChannelMsg::Success => {
                    let _ = client_handle.channel_success(client_channel_id).await;
                }
                ChannelMsg::Failure => {
                    let _ = client_handle.channel_failure(client_channel_id).await;
                }
                ChannelMsg::Eof => {
                    let _ = client_handle.eof(client_channel_id).await;
                }
                ChannelMsg::Close => {
                    let _ = client_handle.close(client_channel_id).await;
                    break;
                }
                _ => {}
            }
        }
        let _ = client_handle.close(client_channel_id).await;
    });
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    const ALICE_KEY: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILM+rvN+ot98qgEN796jTiQfZfG1KaT0PtFDJ/XFSqti alice@example";
    const OTHER_KEY: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ other@example";

    #[test]
    fn parses_two_and_three_part_logins_case_insensitively() {
        assert_eq!(
            ParsedLogin::parse("Alice.Work"),
            Some(ParsedLogin {
                username: "alice".to_string(),
                server_slug: None,
                container_name: "work".to_string(),
            }),
        );
        assert_eq!(
            ParsedLogin::parse("Alice.CPU-A.Work"),
            Some(ParsedLogin {
                username: "alice".to_string(),
                server_slug: Some("cpu-a".to_string()),
                container_name: "work".to_string(),
            }),
        );
        assert_eq!(ParsedLogin::parse("alice.cpu-a.work.extra"), None);
    }

    #[test]
    fn rejects_ambiguous_omitted_server_login() {
        let snapshot = fixture_snapshot();
        assert_rejects(
            snapshot.resolve_login("alice.work"),
            RejectReason::AmbiguousContainer,
        );
    }

    #[test]
    fn accepts_unique_omitted_server_and_explicit_duplicate() {
        let snapshot = fixture_snapshot();
        let RouteResolution::Accepted(unique) = snapshot.resolve_login("alice.solo") else {
            panic!("expected accepted route");
        };
        assert_eq!(unique.container.id, "container-c");
        assert_eq!(unique.server.slug, "cpu-a");

        let RouteResolution::Accepted(explicit) = snapshot.resolve_login("ALICE.CPU-B.WORK") else {
            panic!("expected accepted route");
        };
        assert_eq!(explicit.container.id, "container-b");
        assert_eq!(explicit.server.slug, "cpu-b");
    }

    #[test]
    fn rejects_disabled_user_disabled_image_and_inactive_routes() {
        let snapshot = fixture_snapshot();
        assert_rejects(
            snapshot.resolve_login("disabled.solo"),
            RejectReason::UserDisabled,
        );
        assert_rejects(
            snapshot.resolve_login("alice.gpu"),
            RejectReason::RouteNotFound,
        );
        assert_rejects(
            snapshot.resolve_login("alice.sleeping"),
            RejectReason::RouteNotFound,
        );
    }

    #[test]
    fn parses_authorized_key_lines_with_comments() {
        let parsed = parse_authorized_key(ALICE_KEY).expect("expected public key");
        let without_comment = parse_authorized_key(
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILM+rvN+ot98qgEN796jTiQfZfG1KaT0PtFDJ/XFSqti",
        )
        .expect("expected public key without comment");
        let with_option = parse_authorized_key(
            "restrict ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILM+rvN+ot98qgEN796jTiQfZfG1KaT0PtFDJ/XFSqti",
        )
        .expect("expected public key with option prefix");
        assert_eq!(parsed, without_comment);
        assert_eq!(parsed, with_option);
        assert_eq!(parse_authorized_key("not-a-key"), None);
    }

    #[test]
    fn public_key_auth_matches_snapshot_user_keys() {
        let snapshot = fixture_snapshot();
        let allowed = parse_authorized_key(ALICE_KEY).expect("expected allowed key");
        let other = parse_authorized_key(OTHER_KEY).expect("expected other key");

        assert!(snapshot.public_key_allowed("alice.cpu-a.solo", &allowed));
        assert!(snapshot.public_key_allowed("ALICE.SOLO", &allowed));
        assert!(!snapshot.public_key_allowed("alice.cpu-a.solo", &other));
        assert!(!snapshot.public_key_allowed("disabled.solo", &allowed));
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

    fn assert_rejects(actual: RouteResolution<'_>, expected: RejectReason) {
        match actual {
            RouteResolution::Rejected(reason) => assert_eq!(reason, expected),
            RouteResolution::Accepted(route) => panic!("expected rejection, got {route:?}"),
        }
    }

    fn fixture_snapshot() -> RoutingSnapshot {
        RoutingSnapshot::from_snapshot(ProxySnapshot {
            generation: 7,
            stale_after_ms: 300_000,
            host_key: ProxyHostKey {
                private_key: "PRIVATE".to_string(),
                public_key: "ssh-ed25519 HOST".to_string(),
                fingerprint: "SHA256:host".to_string(),
                generation: 1,
            },
            users: vec![
                ProxyUser {
                    id: "user-a".to_string(),
                    username: "alice".to_string(),
                    status: "active".to_string(),
                    public_keys: vec![ALICE_KEY.to_string()],
                    internal_private_key: "PRIVATE".to_string(),
                    internal_public_key: "ssh-ed25519 INTERNAL".to_string(),
                    internal_key_fingerprint: "SHA256:internal".to_string(),
                    internal_key_generation: 1,
                },
                ProxyUser {
                    id: "user-b".to_string(),
                    username: "disabled".to_string(),
                    status: "disabled".to_string(),
                    public_keys: vec![],
                    internal_private_key: "PRIVATE".to_string(),
                    internal_public_key: "ssh-ed25519 INTERNAL".to_string(),
                    internal_key_fingerprint: "SHA256:internal".to_string(),
                    internal_key_generation: 1,
                },
            ],
            servers: vec![
                ProxyServer {
                    id: "server-a".to_string(),
                    slug: "cpu-a".to_string(),
                    name: "CPU A".to_string(),
                },
                ProxyServer {
                    id: "server-b".to_string(),
                    slug: "cpu-b".to_string(),
                    name: "CPU B".to_string(),
                },
            ],
            images: vec![
                ProxyImage {
                    id: "image-a".to_string(),
                    disable_ssh: false,
                },
                ProxyImage {
                    id: "image-b".to_string(),
                    disable_ssh: true,
                },
            ],
            containers: vec![
                container("container-a", "user-a", "server-a", "image-a", "work"),
                container("container-b", "user-a", "server-b", "image-a", "work"),
                container("container-c", "user-a", "server-a", "image-a", "solo"),
                container("container-d", "user-a", "server-a", "image-b", "gpu"),
                container("container-e", "user-a", "server-a", "image-a", "sleeping"),
                container("container-f", "user-b", "server-a", "image-a", "solo"),
            ],
            routes: vec![
                route(
                    "container-a",
                    "server-a",
                    "runtime-a",
                    Some("10.0.0.2"),
                    "running",
                    "running",
                ),
                route(
                    "container-b",
                    "server-b",
                    "runtime-b",
                    Some("10.0.0.3"),
                    "running",
                    "running",
                ),
                route(
                    "container-c",
                    "server-a",
                    "runtime-c",
                    Some("10.0.0.4"),
                    "running",
                    "running",
                ),
                route(
                    "container-d",
                    "server-a",
                    "runtime-d",
                    Some("10.0.0.5"),
                    "running",
                    "running",
                ),
                route(
                    "container-e",
                    "server-a",
                    "runtime-e",
                    Some("10.0.0.6"),
                    "exited",
                    "container_stopped",
                ),
                route(
                    "container-f",
                    "server-a",
                    "runtime-f",
                    Some("10.0.0.7"),
                    "running",
                    "running",
                ),
            ],
        })
    }

    fn container(
        id: &str,
        owner_id: &str,
        server_id: &str,
        image_id: &str,
        name: &str,
    ) -> ProxyContainer {
        ProxyContainer {
            id: id.to_string(),
            owner_id: owner_id.to_string(),
            server_id: server_id.to_string(),
            image_id: image_id.to_string(),
            name: name.to_string(),
            deleted: false,
        }
    }

    fn route(
        container_id: &str,
        server_id: &str,
        runtime_id: &str,
        macvlan_ip: Option<&str>,
        runtime_status: &str,
        ssh_status: &str,
    ) -> ProxyRoute {
        ProxyRoute {
            container_id: container_id.to_string(),
            server_id: server_id.to_string(),
            runtime_id: runtime_id.to_string(),
            macvlan_ip: macvlan_ip.map(ToOwned::to_owned),
            runtime_status: runtime_status.to_string(),
            ssh_status: ssh_status.to_string(),
            applied_internal_key_generation: Some(1),
            container_host_key_fingerprint: Some("SHA256:container".to_string()),
            observed_at: "2026-06-08T00:00:00.000Z".to_string(),
        }
    }
}
