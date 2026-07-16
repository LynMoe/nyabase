use std::collections::HashMap;
use std::future::Future;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use arc_swap::ArcSwapOption;
use futures_util::future::{AbortHandle, AbortRegistration, Abortable};
use futures_util::{Sink, SinkExt, StreamExt};
use russh::client::Msg as ClientMsg;
use russh::keys::key::PrivateKeyWithHashAlg;
use russh::keys::{decode_secret_key, parse_public_key_base64, HashAlg, PrivateKey, PublicKey};
use russh::server::{Auth, Msg as ServerMsg, Session};
use russh::{
    Channel, ChannelId, ChannelMsg, ChannelReadHalf, ChannelWriteHalf, MethodKind, MethodSet, Pty,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::io;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch, Semaphore};
use tokio::task::JoinSet;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use tracing::{debug, info, warn};

type TelemetrySender = mpsc::Sender<ProxyEvent>;
const BACKEND_CONTROL_WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const SSH_PROXY_SNAPSHOT_STALE_MIN_MS: u64 = 120_000;
const SSH_PROXY_SNAPSHOT_STALE_MAX_MS: u64 = 300_000;
const MAX_SNAPSHOT_CLOCK_SKEW_MS: u64 = 30_000;
const MIN_CONTROL_TOKEN_BYTES: usize = 32;
const MAX_CONTROL_TOKEN_BYTES: usize = 1024;
const MAX_PROXY_CONNECTIONS: usize = 1024;
const MIN_STATUS_INTERVAL_MS: u64 = 250;
const MAX_STATUS_INTERVAL_MS: u64 = 60_000;
const MAX_CHANNELS_PER_CONNECTION: usize = 16;
const MAX_REMOTE_FORWARDS_PER_CONNECTION: usize = 8;
const MAX_CHILD_TASKS_PER_CONNECTION: usize = 64;

fn valid_snapshot_stale_after_ms(value: u64) -> bool {
    (SSH_PROXY_SNAPSHOT_STALE_MIN_MS..=SSH_PROXY_SNAPSHOT_STALE_MAX_MS).contains(&value)
}

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
        let token = required_control_token("SSH_PROXY_TOKEN")?;
        let listen =
            std::env::var("NYABASE_SSH_LISTEN").unwrap_or_else(|_| "0.0.0.0:2222".to_string());
        let max_connections =
            validate_connection_cap(env_usize("NYABASE_SSH_MAX_CONNECTIONS", 512)?)?;
        let reconnect_delay_ms = env_u64("NYABASE_BACKEND_RECONNECT_MS", 2_000)?;
        let route_connect_timeout_ms = env_u64("NYABASE_SSH_ROUTE_CONNECT_TIMEOUT_MS", 10_000)?;
        let status_interval_ms =
            validate_status_interval(env_u64("NYABASE_SSH_STATUS_INTERVAL_MS", 1_000)?)?;

        Ok(Self {
            backend_ws,
            token,
            listen,
            max_connections,
            reconnect_delay: Duration::from_millis(reconnect_delay_ms),
            route_connect_timeout: Duration::from_millis(route_connect_timeout_ms),
            status_interval: Duration::from_millis(status_interval_ms),
        })
    }
}

struct SnapshotStore {
    current: ArcSwapOption<RoutingSnapshot>,
    write_lock: Mutex<()>,
    changes: watch::Sender<u64>,
}

impl Default for SnapshotStore {
    fn default() -> Self {
        let (changes, _) = watch::channel(0);
        Self {
            current: ArcSwapOption::empty(),
            write_lock: Mutex::new(()),
            changes,
        }
    }
}

impl SnapshotStore {
    fn store(&self, snapshot: ProxySnapshot) -> Result<bool> {
        let generation = snapshot.generation;
        let routing = RoutingSnapshot::from_snapshot(snapshot)?;
        let _write = lock(&self.write_lock);
        if self
            .load()
            .is_some_and(|current| generation <= current.generation)
        {
            debug!(generation, "ignored non-increasing SSH proxy snapshot");
            return Ok(false);
        }
        let route_count = routing.routes_by_container_id.len();
        self.current.store(Some(Arc::new(routing)));
        drop(_write);
        self.signal_change();
        info!(generation, route_count, "installed SSH proxy snapshot");
        Ok(true)
    }

    fn load(&self) -> Option<Arc<RoutingSnapshot>> {
        self.current.load_full()
    }

    fn clear(&self) {
        let _write = lock(&self.write_lock);
        self.current.store(None);
        drop(_write);
        self.signal_change();
    }

    fn current_lease(&self) -> Option<(u64, Instant)> {
        self.load()
            .map(|snapshot| (snapshot.generation, snapshot.deadline))
    }

    fn expire(&self, generation: u64, deadline: Instant) -> bool {
        let _write = lock(&self.write_lock);
        let should_expire = self.current.load_full().is_some_and(|current| {
            current.generation == generation && current.deadline == deadline && !current.is_fresh()
        });
        if should_expire {
            self.current.store(None);
        }
        drop(_write);
        if should_expire {
            self.signal_change();
        }
        should_expire
    }

    fn subscribe(&self) -> watch::Receiver<u64> {
        self.changes.subscribe()
    }

    fn signal_change(&self) {
        self.changes
            .send_modify(|revision| *revision = revision.wrapping_add(1));
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
    authenticated_public_key: Mutex<Option<PublicKey>>,
    route: Mutex<Option<ConnectionRouteInfo>>,
    abort_handle: AbortHandle,
    revoked: AtomicBool,
    next_child_id: AtomicU64,
    child_abort_handles: Mutex<HashMap<u64, AbortHandle>>,
}

struct ChildTaskPermit {
    connection: Arc<ConnectionState>,
    id: Option<u64>,
    registration: Option<AbortRegistration>,
}

struct ChildTaskCleanup {
    connection: Arc<ConnectionState>,
    id: u64,
}

impl Drop for ChildTaskCleanup {
    fn drop(&mut self) {
        self.connection.unregister_child_abort(self.id);
    }
}

impl ChildTaskPermit {
    fn spawn<F>(mut self, future: F)
    where
        F: Future<Output = ()> + Send + 'static,
    {
        let id = self.id.take().expect("child task permit id");
        let registration = self
            .registration
            .take()
            .expect("child task permit registration");
        let connection = self.connection.clone();
        tokio::spawn(async move {
            let _cleanup = ChildTaskCleanup { connection, id };
            let _ = Abortable::new(future, registration).await;
        });
    }
}

impl Drop for ChildTaskPermit {
    fn drop(&mut self) {
        if let Some(id) = self.id.take() {
            self.connection.unregister_child_abort(id);
        }
    }
}

#[derive(Clone)]
struct ConnectionRouteInfo {
    user_id: String,
    username: String,
    server_id: String,
    server_slug: String,
    container_id: String,
    container_name: String,
    runtime_id: String,
    macvlan_ip: String,
    internal_key_generation: u64,
    internal_key_fingerprint: String,
    internal_private_key_identity: String,
    container_host_key_fingerprint: String,
}

impl ConnectionRouteInfo {
    fn matches(&self, route: &OwnedResolvedRoute) -> bool {
        self.user_id == route.user_id
            && self.username == route.username
            && self.server_id == route.server_id
            && self.server_slug == route.server_slug
            && self.container_id == route.container_id
            && self.container_name == route.container_name
            && self.runtime_id == route.runtime_id
            && self.macvlan_ip == route.macvlan_ip
            && self.internal_key_generation == route.internal_key_generation
            && self.internal_key_fingerprint == route.internal_key_fingerprint
            && self.internal_private_key_identity == route.internal_private_key_identity
            && self.container_host_key_fingerprint == route.container_host_key_fingerprint
    }
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

    fn clear_snapshot(&self) {
        self.last_snapshot_generation.store(0, Ordering::Relaxed);
        self.last_snapshot_at.store(0, Ordering::Relaxed);
    }

    fn record_rejected_connection(&self) {
        self.total_rejected_connections
            .fetch_add(1, Ordering::Relaxed);
    }

    fn register_connection(&self, peer: SocketAddr) -> (Arc<ConnectionState>, AbortRegistration) {
        let sequence = self.total_connections.fetch_add(1, Ordering::Relaxed) + 1;
        let (connection, abort_registration) = ConnectionState::new(sequence, peer);
        let connection = Arc::new(connection);
        lock(&self.connections).insert(connection.id.clone(), connection.clone());
        (connection, abort_registration)
    }

    fn unregister_connection(&self, id: &str) {
        if let Some(connection) = lock(&self.connections).remove(id) {
            // Natural session completion is also the ownership boundary for
            // every relay and forward spawned by that session.
            connection.abort();
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
        let connections = {
            let connections = lock(&self.connections);
            connections.values().cloned().collect::<Vec<_>>()
        };
        let disconnected = connections
            .into_iter()
            .filter(|connection| connection.abort())
            .count();
        debug!(disconnected, %reason, "aborted SSH proxy connections");
        disconnected
    }

    async fn disconnect_invalid(&self, snapshot: Option<&RoutingSnapshot>, reason: &str) -> usize {
        let connections = {
            let connections = lock(&self.connections);
            connections
                .values()
                .filter(|connection| !connection.authorization_matches(snapshot))
                .cloned()
                .collect::<Vec<_>>()
        };
        let disconnected = connections
            .into_iter()
            .filter(|connection| connection.abort())
            .count();
        debug!(disconnected, %reason, "aborted revoked SSH proxy connections");
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

struct ConnectionCleanup {
    runtime: Arc<ProxyRuntime>,
    id: String,
}

impl Drop for ConnectionCleanup {
    fn drop(&mut self) {
        self.runtime.unregister_connection(&self.id);
    }
}

impl ConnectionState {
    fn new(sequence: u64, peer: SocketAddr) -> (Self, AbortRegistration) {
        let (abort_handle, abort_registration) = AbortHandle::new_pair();
        (
            Self {
                id: format!("conn-{sequence}"),
                peer: peer.to_string(),
                connected_at: now_ms(),
                authenticated_at: AtomicU64::new(0),
                bytes_from_client: AtomicU64::new(0),
                bytes_to_client: AtomicU64::new(0),
                channels: AtomicUsize::new(0),
                login: Mutex::new(None),
                authenticated_public_key: Mutex::new(None),
                route: Mutex::new(None),
                abort_handle,
                revoked: AtomicBool::new(false),
                next_child_id: AtomicU64::new(1),
                child_abort_handles: Mutex::new(HashMap::new()),
            },
            abort_registration,
        )
    }

    fn abort(&self) -> bool {
        if self.revoked.swap(true, Ordering::AcqRel) {
            return false;
        }
        self.abort_handle.abort();
        let children = std::mem::take(&mut *lock(&self.child_abort_handles));
        for handle in children.into_values() {
            handle.abort();
        }
        true
    }

    fn register_child_abort(&self, handle: AbortHandle) -> Option<u64> {
        let mut children = lock(&self.child_abort_handles);
        if self.revoked.load(Ordering::Acquire) {
            handle.abort();
            return None;
        }
        if children.len() >= MAX_CHILD_TASKS_PER_CONNECTION {
            handle.abort();
            return None;
        }
        let id =
            match self
                .next_child_id
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
                    current.checked_add(1)
                }) {
                Ok(id) => id,
                Err(_) => {
                    handle.abort();
                    return None;
                }
            };
        children.insert(id, handle);
        Some(id)
    }

    fn try_reserve_child_task(self: &Arc<Self>) -> Option<ChildTaskPermit> {
        let (abort_handle, registration) = AbortHandle::new_pair();
        let id = self.register_child_abort(abort_handle)?;
        Some(ChildTaskPermit {
            connection: self.clone(),
            id: Some(id),
            registration: Some(registration),
        })
    }

    fn unregister_child_abort(&self, id: u64) {
        lock(&self.child_abort_handles).remove(&id);
    }

    fn set_authenticated(&self, login: &str, public_key: &PublicKey, route: &OwnedResolvedRoute) {
        *lock(&self.login) = Some(login.to_string());
        *lock(&self.authenticated_public_key) = Some(public_key.clone());
        *lock(&self.route) = Some(ConnectionRouteInfo {
            user_id: route.user_id.clone(),
            username: route.username.clone(),
            server_id: route.server_id.clone(),
            server_slug: route.server_slug.clone(),
            container_id: route.container_id.clone(),
            container_name: route.container_name.clone(),
            runtime_id: route.runtime_id.clone(),
            macvlan_ip: route.macvlan_ip.clone(),
            internal_key_generation: route.internal_key_generation,
            internal_key_fingerprint: route.internal_key_fingerprint.clone(),
            internal_private_key_identity: route.internal_private_key_identity.clone(),
            container_host_key_fingerprint: route.container_host_key_fingerprint.clone(),
        });
        self.authenticated_at.store(now_ms(), Ordering::Relaxed);
    }

    fn authorization_matches(&self, snapshot: Option<&RoutingSnapshot>) -> bool {
        let login = lock(&self.login).clone();
        if login.is_none() {
            // Pre-authentication sessions re-read SnapshotStore on every auth
            // callback, so there is no pinned authorization to revoke here.
            return true;
        }
        let Some(snapshot) = snapshot.filter(|snapshot| snapshot.is_fresh()) else {
            return false;
        };
        let Some(public_key) = lock(&self.authenticated_public_key).clone() else {
            return false;
        };
        let Some(expected) = lock(&self.route).clone() else {
            return false;
        };
        let login = login.expect("checked above");
        if !snapshot.public_key_allowed(&login, &public_key) {
            return false;
        }
        resolve_owned_route(snapshot, &login).is_ok_and(|current| expected.matches(&current))
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

fn required_control_token(name: &str) -> Result<String> {
    let token = std::env::var(name).with_context(|| format!("{name} is required"))?;
    validate_control_token(name, &token)?;
    Ok(token)
}

fn validate_control_token(name: &str, token: &str) -> Result<()> {
    if !(MIN_CONTROL_TOKEN_BYTES..=MAX_CONTROL_TOKEN_BYTES).contains(&token.len()) {
        anyhow::bail!("{name} must be {MIN_CONTROL_TOKEN_BYTES}..={MAX_CONTROL_TOKEN_BYTES} bytes");
    }
    if !token
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        anyhow::bail!("{name} must use only ASCII letters, digits, '_' or '-'");
    }
    Ok(())
}

fn validate_connection_cap(value: usize) -> Result<usize> {
    if !(1..=MAX_PROXY_CONNECTIONS).contains(&value) {
        anyhow::bail!("NYABASE_SSH_MAX_CONNECTIONS must be in 1..={MAX_PROXY_CONNECTIONS}");
    }
    Ok(value)
}

fn validate_status_interval(value: u64) -> Result<u64> {
    if !(MIN_STATUS_INTERVAL_MS..=MAX_STATUS_INTERVAL_MS).contains(&value) {
        anyhow::bail!(
            "NYABASE_SSH_STATUS_INTERVAL_MS must be in {MIN_STATUS_INTERVAL_MS}..={MAX_STATUS_INTERVAL_MS}"
        );
    }
    Ok(value)
}

fn env_u64(name: &str, fallback: u64) -> Result<u64> {
    match std::env::var(name) {
        Ok(value) => value
            .parse()
            .with_context(|| format!("{name} must be an unsigned integer")),
        Err(std::env::VarError::NotPresent) => Ok(fallback),
        Err(error) => Err(error).with_context(|| format!("failed to read {name}")),
    }
}

fn env_usize(name: &str, fallback: usize) -> Result<usize> {
    match std::env::var(name) {
        Ok(value) => value
            .parse()
            .with_context(|| format!("{name} must be an unsigned integer")),
        Err(std::env::VarError::NotPresent) => Ok(fallback),
        Err(error) => Err(error).with_context(|| format!("failed to read {name}")),
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
    let mut tasks = JoinSet::new();

    spawn_supervised(
        &mut tasks,
        "SSH proxy backend loop",
        run_backend_loop(config.clone(), store.clone(), runtime.clone(), telemetry_rx),
    );
    spawn_supervised(
        &mut tasks,
        "SSH proxy snapshot lease loop",
        run_snapshot_expiry(store.clone(), runtime.clone()),
    );
    spawn_supervised(
        &mut tasks,
        "SSH proxy public listener",
        run_public_listener(config, store, runtime, telemetry_tx),
    );

    supervise_until_shutdown(&mut tasks).await
}

fn spawn_supervised<F>(
    tasks: &mut JoinSet<(&'static str, Result<()>)>,
    name: &'static str,
    future: F,
) where
    F: Future<Output = Result<()>> + Send + 'static,
{
    tasks.spawn(async move { (name, future.await) });
}

async fn supervise_until_shutdown(tasks: &mut JoinSet<(&'static str, Result<()>)>) -> Result<()> {
    let outcome = tokio::select! {
        signal = tokio::signal::ctrl_c() => {
            signal.context("failed to wait for SSH proxy shutdown signal")?;
            Ok(())
        }
        completed = tasks.join_next() => {
            match completed {
                Some(Ok((name, Ok(())))) => Err(anyhow::anyhow!("{name} exited unexpectedly")),
                Some(Ok((name, Err(error)))) => Err(error).with_context(|| format!("{name} failed")),
                Some(Err(error)) => Err(anyhow::anyhow!("supervised SSH proxy task failed: {error}")),
                None => Err(anyhow::anyhow!("all supervised SSH proxy tasks exited unexpectedly")),
            }
        }
    };
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    outcome
}

async fn run_backend_loop(
    config: ProxyConfig,
    store: Arc<SnapshotStore>,
    runtime: Arc<ProxyRuntime>,
    mut telemetry_rx: mpsc::Receiver<ProxyEvent>,
) -> Result<()> {
    loop {
        if let Err(error) = run_backend_once(&config, &store, &runtime, &mut telemetry_rx).await {
            warn!(%error, "SSH proxy backend websocket disconnected");
        }
        revoke_control_plane(&store, &runtime, "SSH proxy control plane disconnected").await;
        tokio::time::sleep(config.reconnect_delay).await;
    }
}

async fn run_snapshot_expiry(store: Arc<SnapshotStore>, runtime: Arc<ProxyRuntime>) -> Result<()> {
    let mut changes = store.subscribe();
    loop {
        match store.current_lease() {
            Some((generation, deadline)) => {
                tokio::select! {
                    biased;
                    changed = changes.changed() => {
                        changed.context("SSH proxy snapshot lease notifier closed")?;
                    }
                    _ = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)) => {
                        if store.expire(generation, deadline) {
                            runtime.clear_snapshot();
                            runtime
                                .disconnect_invalid(None, "SSH proxy snapshot expired")
                                .await;
                            warn!(generation, "SSH proxy snapshot lease expired");
                        }
                    }
                }
            }
            None => {
                changes
                    .changed()
                    .await
                    .context("SSH proxy snapshot lease notifier closed")?;
            }
        }
    }
}

async fn revoke_control_plane(store: &SnapshotStore, runtime: &ProxyRuntime, reason: &str) {
    // A disconnected or write-blocked control plane is not authoritative.
    // Clearing first makes concurrent authentication fail closed; direct task
    // abort then closes every already-authenticated transport and child bridge.
    store.clear();
    runtime.clear_snapshot();
    runtime.disconnect_invalid(None, reason).await;
}

async fn send_control_frame<S>(write: &mut S, message: Message, timeout: Duration) -> Result<()>
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
    // Snapshot generation is scoped to one Backend WebSocket connection. This
    // permits a freshly restarted Backend to begin at generation 1 while still
    // rejecting reordering within a live connection.
    store.clear();
    runtime.clear_snapshot();
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
                send_control_frame(
                    &mut write,
                    Message::Text(serde_json::to_string(&envelope)?.into()),
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
                        let generation = install_backend_snapshot(store, runtime, snapshot).await?;
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

async fn install_backend_snapshot(
    store: &SnapshotStore,
    runtime: &ProxyRuntime,
    snapshot: ProxySnapshot,
) -> Result<u64> {
    let generation = snapshot.generation;
    if !valid_snapshot_stale_after_ms(snapshot.stale_after_ms) {
        revoke_control_plane(
            store,
            runtime,
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
    match store.store(snapshot) {
        Ok(true) => {
            runtime.mark_snapshot(generation);
            let current = store.load();
            runtime
                .disconnect_invalid(current.as_deref(), "SSH proxy authorization changed")
                .await;
        }
        Ok(false) => {}
        Err(error) => {
            revoke_control_plane(store, runtime, "SSH proxy snapshot was rejected").await;
            return Err(error);
        }
    }
    Ok(generation)
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
            let (connection, abort_registration) = runtime.register_connection(peer);
            let _cleanup = ConnectionCleanup {
                runtime: runtime.clone(),
                id: connection.id.clone(),
            };
            emit_metric(
                &telemetry,
                "ssh_proxy_connections_total",
                vec![("result", "accepted".to_string())],
                1.0,
            );
            let connection_result = Abortable::new(
                handle_ssh_connection(
                    stream,
                    peer,
                    store,
                    config,
                    telemetry.clone(),
                    connection.clone(),
                ),
                abort_registration,
            )
            .await;
            match connection_result {
                Ok(Err(error)) => {
                    debug!(%peer, %error, "SSH connection closed");
                    emit_metric(
                        &telemetry,
                        "ssh_proxy_connections_total",
                        vec![("result", "closed_error".to_string())],
                        1.0,
                    );
                }
                Err(_) => debug!(%peer, "SSH connection was revoked and aborted"),
                Ok(Ok(())) => {}
            }
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
    let host_key = snapshot.host_private_key.clone();
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
    let handler = ProxySshSession::new(store, config, peer, telemetry, connection);
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
    valid_until: u64,
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
    online: bool,
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
    deadline: Instant,
    host_private_key: PrivateKey,
    users: Vec<RoutingUser>,
    servers_by_id: HashMap<String, ProxyServer>,
    images_by_id: HashMap<String, ProxyImage>,
    containers: Vec<ProxyContainer>,
    routes_by_container_id: HashMap<String, ProxyRoute>,
}

#[derive(Debug)]
struct RoutingUser {
    id: String,
    username: String,
    status: String,
    public_keys: Vec<String>,
    internal_private_key: Arc<PrivateKey>,
    internal_private_key_identity: String,
    internal_key_fingerprint: String,
    internal_key_generation: u64,
}

impl RoutingUser {
    fn from_proxy(user: ProxyUser) -> Result<Self> {
        let private_key =
            decode_secret_key(&user.internal_private_key, None).with_context(|| {
                format!("failed to parse internal private key for user {}", user.id)
            })?;
        let internal_private_key_identity = ssh_sha256_fingerprint(private_key.public_key());
        Ok(Self {
            id: user.id,
            username: user.username,
            status: user.status,
            public_keys: user.public_keys,
            internal_private_key: Arc::new(private_key),
            internal_private_key_identity,
            internal_key_fingerprint: user.internal_key_fingerprint,
            internal_key_generation: user.internal_key_generation,
        })
    }
}

impl RoutingSnapshot {
    fn from_snapshot(snapshot: ProxySnapshot) -> Result<Self> {
        let remaining =
            absolute_snapshot_remaining(snapshot.valid_until, snapshot.stale_after_ms, now_ms())?;
        let deadline = Instant::now()
            .checked_add(remaining)
            .context("SSH proxy snapshot lease deadline overflow")?;
        let host_private_key = decode_secret_key(&snapshot.host_key.private_key, None)
            .context("failed to parse SSH proxy host private key")?;
        let users = snapshot
            .users
            .into_iter()
            .map(RoutingUser::from_proxy)
            .collect::<Result<Vec<_>>>()?;
        Ok(Self {
            generation: snapshot.generation,
            deadline,
            host_private_key,
            users,
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
        })
    }

    fn is_fresh(&self) -> bool {
        Instant::now() < self.deadline
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
            if container.owner_id != user.id {
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
            if !server.online {
                continue;
            }
            if let Some(server_slug) = &parsed.server_slug {
                if !server.slug.eq_ignore_ascii_case(server_slug) {
                    continue;
                }
            }
            let Some(route) = self.routes_by_container_id.get(&container.id) else {
                continue;
            };
            if route.server_id != container.server_id {
                continue;
            }
            if !route.is_active_for(user.internal_key_generation) {
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
            _ => RouteResolution::Rejected(RejectReason::AmbiguousContainer),
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
    fn is_active_for(&self, expected_key_generation: u64) -> bool {
        self.macvlan_ip
            .as_deref()
            .is_some_and(is_routable_container_ipv4)
            && self.runtime_status == "running"
            && self.ssh_status == "running"
            && self.applied_internal_key_generation == Some(expected_key_generation)
            && self
                .container_host_key_fingerprint
                .as_deref()
                .is_some_and(is_sha256_fingerprint)
    }
}

fn is_routable_container_ipv4(value: &str) -> bool {
    value.parse::<Ipv4Addr>().is_ok_and(|address| {
        !address.is_unspecified()
            && !address.is_loopback()
            && !address.is_multicast()
            && address != Ipv4Addr::BROADCAST
    })
}

fn is_sha256_fingerprint(value: &str) -> bool {
    let Some(encoded) = value.strip_prefix("SHA256:") else {
        return false;
    };
    encoded.len() == 43
        && encoded
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/')
}

fn ssh_sha256_fingerprint(public_key: &PublicKey) -> String {
    public_key.fingerprint(HashAlg::Sha256).to_string()
}

fn host_key_matches(expected_fingerprint: &str, public_key: &PublicKey) -> bool {
    ssh_sha256_fingerprint(public_key) == expected_fingerprint
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
    user: &'a RoutingUser,
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
    store: Arc<SnapshotStore>,
    config: ProxyConfig,
    peer: SocketAddr,
    telemetry: TelemetrySender,
    connection: Arc<ConnectionState>,
    authenticated_login: Option<String>,
    authenticated_public_key: Option<PublicKey>,
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
    internal_private_key: Arc<PrivateKey>,
    internal_private_key_identity: String,
    internal_key_generation: u64,
    internal_key_fingerprint: String,
    container_host_key_fingerprint: String,
}

impl OwnedResolvedRoute {
    fn same_authority(&self, other: &Self) -> bool {
        self.user_id == other.user_id
            && self.username == other.username
            && self.server_id == other.server_id
            && self.server_slug == other.server_slug
            && self.container_id == other.container_id
            && self.container_name == other.container_name
            && self.runtime_id == other.runtime_id
            && self.macvlan_ip == other.macvlan_ip
            && self.internal_private_key_identity == other.internal_private_key_identity
            && self.internal_key_generation == other.internal_key_generation
            && self.internal_key_fingerprint == other.internal_key_fingerprint
            && self.container_host_key_fingerprint == other.container_host_key_fingerprint
    }
}

fn resolve_owned_route(
    snapshot: &RoutingSnapshot,
    login: &str,
) -> Result<OwnedResolvedRoute, RejectReason> {
    match snapshot.resolve_login(login) {
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
            internal_private_key_identity: route.user.internal_private_key_identity.clone(),
            internal_key_generation: route.user.internal_key_generation,
            internal_key_fingerprint: route.user.internal_key_fingerprint.clone(),
            container_host_key_fingerprint: route
                .route
                .container_host_key_fingerprint
                .clone()
                .expect("active SSH route must carry a validated host-key fingerprint"),
        }),
        RouteResolution::Rejected(reason) => Err(reason),
    }
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
    expected_host_key_fingerprint: String,
}

impl ProxySshSession {
    fn new(
        store: Arc<SnapshotStore>,
        config: ProxyConfig,
        peer: SocketAddr,
        telemetry: TelemetrySender,
        connection: Arc<ConnectionState>,
    ) -> Self {
        Self {
            store,
            config,
            peer,
            telemetry,
            connection,
            authenticated_login: None,
            authenticated_public_key: None,
            resolved_route: None,
            channels: HashMap::new(),
            remote_forwards: HashMap::new(),
        }
    }

    fn latest_snapshot(&self) -> Option<Arc<RoutingSnapshot>> {
        self.store.load().filter(|snapshot| snapshot.is_fresh())
    }

    fn authorized_route(&self) -> Result<OwnedResolvedRoute> {
        let login = self
            .authenticated_login
            .as_deref()
            .context("SSH proxy session is not authenticated")?;
        let public_key = self
            .authenticated_public_key
            .as_ref()
            .context("SSH proxy session has no authenticated public key")?;
        let expected = self
            .resolved_route
            .as_ref()
            .context("SSH proxy session has no authenticated route")?;
        let snapshot = self
            .latest_snapshot()
            .context("no fresh SSH proxy snapshot is installed")?;
        if !snapshot.public_key_allowed(login, public_key) {
            anyhow::bail!("SSH proxy authorization was revoked");
        }
        let current = resolve_owned_route(&snapshot, login)
            .map_err(|reason| anyhow::anyhow!(reason.to_string()))?;
        if !current.same_authority(expected) {
            anyhow::bail!("SSH proxy route authorization changed");
        }
        Ok(current)
    }

    async fn connect_upstream(
        &self,
        client_handle: russh::server::Handle,
    ) -> Result<Option<russh::client::Handle<ContainerClient>>> {
        let route = self.authorized_route()?;
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
            expected_host_key_fingerprint: route.container_host_key_fingerprint.clone(),
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
                    route.internal_private_key.clone(),
                    upstream.best_supported_rsa_hash().await?.flatten(),
                ),
            )
            .await?;
        if !auth.success() {
            anyhow::bail!("container internal key authentication failed");
        }
        if !self.authorized_route()?.same_authority(&route) {
            let _ = upstream
                .disconnect(
                    russh::Disconnect::ByApplication,
                    "SSH proxy authorization changed",
                    "",
                )
                .await;
            anyhow::bail!("SSH proxy authorization changed while connecting upstream");
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
        if self.channels.len() >= MAX_CHANNELS_PER_CONNECTION {
            warn!(peer = %self.peer, channel = ?channel_id, "SSH session channel limit reached");
            emit_metric(
                &self.telemetry,
                "ssh_proxy_channels_total",
                vec![
                    ("kind", "session".to_string()),
                    ("result", "rejected_limit".to_string()),
                ],
                1.0,
            );
            let _ = session.handle().close(channel_id).await;
            return Ok(None);
        }
        let Some(relay_permit) = self.connection.try_reserve_child_task() else {
            warn!(peer = %self.peer, channel = ?channel_id, "SSH child task limit reached");
            emit_metric(
                &self.telemetry,
                "ssh_proxy_channels_total",
                vec![
                    ("kind", "session".to_string()),
                    ("result", "rejected_child_limit".to_string()),
                ],
                1.0,
            );
            let _ = session.handle().close(channel_id).await;
            return Ok(None);
        };

        let Some(upstream) = self.connect_upstream(session.handle()).await? else {
            let _ = session.handle().close(channel_id).await;
            return Ok(None);
        };
        let channel = upstream.channel_open_session().await?;
        let upstream_channel_id = channel.id();
        let (upstream_read, upstream_write) = channel.split();
        let upstream_write = Arc::new(upstream_write);
        spawn_upstream_relay(
            relay_permit,
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

    async fn auth_succeeded(&mut self, _session: &mut Session) -> Result<(), Self::Error> {
        let current = self.store.load();
        if !self.connection.authorization_matches(current.as_deref()) {
            anyhow::bail!("SSH proxy authorization changed during authentication");
        }
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
        if self
            .latest_snapshot()
            .is_some_and(|snapshot| snapshot.public_key_allowed(user, public_key))
        {
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
        let Some(snapshot) = self.latest_snapshot() else {
            self.emit_login_audit(user, None, false, Some("snapshot_unavailable"));
            return Ok(Auth::reject());
        };
        if !snapshot.public_key_allowed(user, public_key) {
            warn!(peer = %self.peer, login = user, "SSH proxy public key rejected");
            self.emit_login_audit(user, None, false, Some("public_key_rejected"));
            return Ok(Auth::reject());
        }
        match resolve_owned_route(&snapshot, user) {
            Ok(route) => {
                info!(
                    peer = %self.peer,
                    login = user,
                    container_id = %route.container_id,
                    server_slug = %route.server_slug,
                    "SSH proxy login authenticated"
                );
                self.emit_login_audit(user, Some(&route), true, None);
                self.connection.set_authenticated(user, public_key, &route);
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
                self.authenticated_public_key = Some(public_key.clone());
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
        let Some(bridge_permit) = self.connection.try_reserve_child_task() else {
            warn!(%peer, "SSH direct-tcpip child task limit reached");
            emit_metric(
                &self.telemetry,
                "ssh_proxy_channels_total",
                vec![
                    ("kind", "direct_tcpip".to_string()),
                    ("result", "rejected_limit".to_string()),
                ],
                1.0,
            );
            let _ = channel.close().await;
            return Ok(false);
        };
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
            bridge_permit,
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
        let requested_key = ForwardKey {
            address: address.to_string(),
            port: requested_port,
        };
        if self.remote_forwards.len() >= MAX_REMOTE_FORWARDS_PER_CONNECTION
            && (requested_port == 0 || !self.remote_forwards.contains_key(&requested_key))
        {
            warn!(%peer, %address, requested_port, "SSH remote forward limit reached");
            emit_metric(
                &self.telemetry,
                "ssh_proxy_forwards_total",
                vec![
                    ("kind", "remote_tcpip".to_string()),
                    ("result", "rejected_limit".to_string()),
                ],
                1.0,
            );
            return Ok(false);
        }
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
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(host_key_matches(
            &self.expected_host_key_fingerprint,
            server_public_key,
        ))
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
        let Some(bridge_permit) = self.connection.try_reserve_child_task() else {
            warn!(peer = %self.peer, "SSH forwarded-tcpip child task limit reached");
            let _ = channel.close().await;
            return Ok(());
        };
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
            bridge_permit,
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
        let Some(bridge_permit) = self.connection.try_reserve_child_task() else {
            warn!(peer = %self.peer, "SSH agent-forward child task limit reached");
            let _ = channel.close().await;
            return Ok(());
        };
        let client_channel = match self.client_handle.channel_open_agent().await {
            Ok(channel) => channel,
            Err(error) => {
                warn!(peer = %self.peer, %error, "failed to open external agent-forward channel");
                let _ = channel.close().await;
                return Ok(());
            }
        };
        spawn_channel_bridge(
            bridge_permit,
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

#[cfg(test)]
fn spawn_connection_task<F>(connection: Arc<ConnectionState>, future: F)
where
    F: Future<Output = ()> + Send + 'static,
{
    let Some(permit) = connection.try_reserve_child_task() else {
        return;
    };
    permit.spawn(future);
}

fn spawn_channel_bridge(
    permit: ChildTaskPermit,
    peer: SocketAddr,
    kind: &'static str,
    client_channel: Channel<ServerMsg>,
    upstream_channel: Channel<ClientMsg>,
    upstream_handle: Option<russh::client::Handle<ContainerClient>>,
    connection: Arc<ConnectionState>,
) {
    let task_connection = connection.clone();
    permit.spawn(async move {
        let mut client_stream = client_channel.into_stream();
        let mut upstream_stream = upstream_channel.into_stream();
        match io::copy_bidirectional(&mut client_stream, &mut upstream_stream).await {
            Ok((from_client, to_client)) => {
                task_connection.record_from_client(from_client as usize);
                task_connection.record_to_client(to_client as usize);
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
    permit: ChildTaskPermit,
    client_channel_id: ChannelId,
    client_handle: russh::server::Handle,
    mut upstream: ChannelReadHalf,
    connection: Arc<ConnectionState>,
) {
    let task_connection = connection.clone();
    permit.spawn(async move {
        while let Some(message) = upstream.wait().await {
            match message {
                ChannelMsg::Data { data } => {
                    task_connection.record_to_client(data.len());
                    if client_handle
                        .data(client_channel_id, data.to_vec())
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                ChannelMsg::ExtendedData { ext, data } => {
                    task_connection.record_to_client(data.len());
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

fn absolute_snapshot_remaining(
    valid_until_ms: u64,
    stale_after_ms: u64,
    wall_now_ms: u64,
) -> Result<Duration> {
    let latest_allowed = wall_now_ms
        .checked_add(stale_after_ms)
        .and_then(|value| value.checked_add(MAX_SNAPSHOT_CLOCK_SKEW_MS))
        .context("SSH proxy snapshot absolute lease overflow")?;
    if valid_until_ms > latest_allowed {
        anyhow::bail!("SSH proxy snapshot validUntil is too far in the future");
    }
    let remaining_ms = valid_until_ms
        .checked_sub(wall_now_ms)
        .filter(|remaining| *remaining > 0)
        .context("SSH proxy snapshot absolute lease already expired")?;
    Ok(Duration::from_millis(remaining_ms))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
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
    const TEST_PRIVATE_KEY: &str = concat!(
        "-----BEGIN OPENSSH PRIVATE KEY-----\n",
        "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n",
        "QyNTUxOQAAACDjj8cE23hVwPTrRtCZZRK9nZcMNpjnRJdbLWeT9+XbeQAAAJh+dobffnaG\n",
        "3wAAAAtzc2gtZWQyNTUxOQAAACDjj8cE23hVwPTrRtCZZRK9nZcMNpjnRJdbLWeT9+XbeQ\n",
        "AAAEDKCliCKTTTtnNjAxywhC+fnOBrbIGRs5FEf9LyBg0InOOPxwTbeFXA9OtG0JllEr2d\n",
        "lww2mOdEl1stZ5P35dt5AAAAEW55YWJhc2UtdGVzdC1vbmx5AQIDBA==\n",
        "-----END OPENSSH PRIVATE KEY-----\n",
    );

    #[test]
    fn control_token_is_required_to_be_trim_exact_and_bounded() {
        assert!(validate_control_token("SSH_PROXY_TOKEN", &"a".repeat(32)).is_ok());
        assert!(validate_control_token("SSH_PROXY_TOKEN", &"a".repeat(1024)).is_ok());
        assert!(validate_control_token("SSH_PROXY_TOKEN", &"a".repeat(31)).is_err());
        assert!(validate_control_token("SSH_PROXY_TOKEN", &"a".repeat(1025)).is_err());
        assert!(
            validate_control_token("SSH_PROXY_TOKEN", &format!(" {}", "a".repeat(32))).is_err()
        );
        assert!(
            validate_control_token("SSH_PROXY_TOKEN", &format!("{}\n", "a".repeat(32))).is_err()
        );
        assert!(validate_control_token(
            "SSH_PROXY_TOKEN",
            &format!("{}\n{}", "a".repeat(16), "a".repeat(16)),
        )
        .is_err());
        assert!(
            validate_control_token("SSH_PROXY_TOKEN", &format!("{} internal", "a".repeat(32)),)
                .is_err()
        );
        assert!(
            validate_control_token("SSH_PROXY_TOKEN", &format!("é{}", "a".repeat(32))).is_err()
        );
    }

    #[test]
    fn connection_cap_and_status_interval_reject_zero_or_excessive_values() {
        assert!(validate_connection_cap(1).is_ok());
        assert!(validate_connection_cap(MAX_PROXY_CONNECTIONS).is_ok());
        assert!(validate_connection_cap(0).is_err());
        assert!(validate_connection_cap(MAX_PROXY_CONNECTIONS + 1).is_err());
        assert!(validate_status_interval(MIN_STATUS_INTERVAL_MS).is_ok());
        assert!(validate_status_interval(MAX_STATUS_INTERVAL_MS).is_ok());
        assert!(validate_status_interval(MIN_STATUS_INTERVAL_MS - 1).is_err());
        assert!(validate_status_interval(MAX_STATUS_INTERVAL_MS + 1).is_err());
    }

    #[tokio::test]
    async fn supervised_task_exit_is_a_process_error() {
        let mut tasks = JoinSet::new();
        spawn_supervised(&mut tasks, "test listener", async { Ok(()) });

        let error = supervise_until_shutdown(&mut tasks)
            .await
            .expect_err("unexpected top-level exit must fail the process");

        assert!(error
            .to_string()
            .contains("test listener exited unexpectedly"));
    }

    #[test]
    fn child_task_registry_is_hard_bounded_and_releases_reservations() {
        let (connection, _main_registration) =
            ConnectionState::new(1, "127.0.0.1:2200".parse().unwrap());
        let connection = Arc::new(connection);
        let mut permits = (0..MAX_CHILD_TASKS_PER_CONNECTION)
            .map(|_| {
                connection
                    .try_reserve_child_task()
                    .expect("reservation below the hard limit")
            })
            .collect::<Vec<_>>();

        assert!(connection.try_reserve_child_task().is_none());
        permits.pop();
        assert!(connection.try_reserve_child_task().is_some());
        drop(permits);
        assert!(lock(&connection.child_abort_handles).is_empty());
    }

    #[tokio::test]
    async fn unregistering_a_connection_aborts_and_cleans_all_child_tasks() {
        let config = ProxyConfig {
            backend_ws: "ws://backend.invalid".to_string(),
            token: "a".repeat(32),
            listen: "127.0.0.1:2222".to_string(),
            max_connections: 8,
            reconnect_delay: Duration::from_secs(1),
            route_connect_timeout: Duration::from_secs(1),
            status_interval: Duration::from_secs(1),
        };
        let runtime = ProxyRuntime::new(&config);
        let (connection, _main_registration) =
            runtime.register_connection("127.0.0.1:2205".parse().unwrap());
        connection
            .try_reserve_child_task()
            .expect("child reservation")
            .spawn(std::future::pending());
        assert_eq!(lock(&connection.child_abort_handles).len(), 1);

        runtime.unregister_connection(&connection.id);

        assert!(connection.revoked.load(Ordering::Acquire));
        assert!(lock(&connection.child_abort_handles).is_empty());
        tokio::task::yield_now().await;
    }

    struct NeverReadySink;

    impl Sink<Message> for NeverReadySink {
        type Error = std::io::Error;

        fn poll_ready(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), Self::Error>> {
            std::task::Poll::Pending
        }

        fn start_send(self: std::pin::Pin<&mut Self>, _item: Message) -> Result<(), Self::Error> {
            Ok(())
        }

        fn poll_flush(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), Self::Error>> {
            std::task::Poll::Pending
        }

        fn poll_close(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), Self::Error>> {
            std::task::Poll::Ready(Ok(()))
        }
    }

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
    fn computes_and_enforces_standard_sha256_container_host_key_fingerprints() {
        let key = parse_authorized_key(ALICE_KEY).expect("expected public key");
        let expected = "SHA256:UCUiLr7Pjs9wFFJMDByLgc3NrtdU344OgUM45wZPcIQ";
        assert_eq!(ssh_sha256_fingerprint(&key), expected);
        assert!(host_key_matches(expected, &key));
        assert!(!host_key_matches(
            "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            &key,
        ));
        assert!(is_sha256_fingerprint(expected));
        assert!(!is_sha256_fingerprint("SHA256:private-file-hash"));
    }

    #[test]
    fn rejects_routes_with_missing_host_identity_or_stale_internal_key_generation() {
        let mut snapshot = fixture_snapshot();
        let route = snapshot
            .routes_by_container_id
            .get_mut("container-c")
            .expect("fixture route");
        route.container_host_key_fingerprint = None;
        assert_rejects(
            snapshot.resolve_login("alice.solo"),
            RejectReason::RouteNotFound,
        );

        let route = snapshot
            .routes_by_container_id
            .get_mut("container-c")
            .expect("fixture route");
        route.container_host_key_fingerprint =
            Some("SHA256:UCUiLr7Pjs9wFFJMDByLgc3NrtdU344OgUM45wZPcIQ".to_string());
        route.applied_internal_key_generation = Some(0);
        assert_rejects(
            snapshot.resolve_login("alice.solo"),
            RejectReason::RouteNotFound,
        );
    }

    #[test]
    fn rejects_offline_wrong_server_and_non_routable_route_addresses() {
        let mut offline = fixture_proxy_snapshot(8);
        offline
            .servers
            .iter_mut()
            .find(|server| server.id == "server-a")
            .unwrap()
            .online = false;
        assert_rejects(
            RoutingSnapshot::from_snapshot(offline)
                .unwrap()
                .resolve_login("alice.solo"),
            RejectReason::RouteNotFound,
        );

        let mut wrong_server = fixture_proxy_snapshot(9);
        wrong_server
            .routes
            .iter_mut()
            .find(|route| route.container_id == "container-c")
            .unwrap()
            .server_id = "server-b".to_string();
        assert_rejects(
            RoutingSnapshot::from_snapshot(wrong_server)
                .unwrap()
                .resolve_login("alice.solo"),
            RejectReason::RouteNotFound,
        );

        for address in ["127.0.0.1", "0.0.0.0", "not-an-ip"] {
            let mut invalid_ip = fixture_proxy_snapshot(10);
            invalid_ip
                .routes
                .iter_mut()
                .find(|route| route.container_id == "container-c")
                .unwrap()
                .macvlan_ip = Some(address.to_string());
            assert_rejects(
                RoutingSnapshot::from_snapshot(invalid_ip)
                    .unwrap()
                    .resolve_login("alice.solo"),
                RejectReason::RouteNotFound,
            );
        }
    }

    #[test]
    fn snapshot_store_rejects_non_increasing_generation_within_an_epoch() {
        let store = SnapshotStore::default();
        assert!(store.store(fixture_proxy_snapshot(7)).unwrap());
        assert!(!store.store(fixture_proxy_snapshot(6)).unwrap());
        assert!(!store.store(fixture_proxy_snapshot(7)).unwrap());
        assert_eq!(store.load().map(|snapshot| snapshot.generation), Some(7));

        // A new Backend WebSocket connection creates a new epoch, so a
        // restarted Backend may safely begin its local generation at one.
        store.clear();
        assert!(store.store(fixture_proxy_snapshot(1)).unwrap());
        assert_eq!(store.load().map(|snapshot| snapshot.generation), Some(1));
    }

    #[tokio::test]
    async fn bad_host_private_key_rejects_before_ack_and_revokes_current_snapshot() {
        let mut invalid = fixture_proxy_snapshot(8);
        invalid.host_key.private_key = "not-an-openssh-private-key".to_string();

        assert_invalid_key_snapshot_revokes(invalid, "failed to parse SSH proxy host private key")
            .await;
    }

    #[tokio::test]
    async fn bad_disabled_user_private_key_rejects_before_ack_and_revokes_current_snapshot() {
        let mut invalid = fixture_proxy_snapshot(8);
        invalid.users[1].internal_private_key = "not-an-openssh-private-key".to_string();

        assert_invalid_key_snapshot_revokes(
            invalid,
            "failed to parse internal private key for user user-b",
        )
        .await;
    }

    async fn assert_invalid_key_snapshot_revokes(invalid: ProxySnapshot, expected_error: &str) {
        let config = ProxyConfig {
            backend_ws: "ws://backend.invalid".to_string(),
            token: "a".repeat(32),
            listen: "127.0.0.1:2222".to_string(),
            max_connections: 8,
            reconnect_delay: Duration::from_secs(1),
            route_connect_timeout: Duration::from_secs(1),
            status_interval: Duration::from_secs(1),
        };
        let store = SnapshotStore::default();
        let runtime = ProxyRuntime::new(&config);
        assert_eq!(
            install_backend_snapshot(&store, &runtime, fixture_proxy_snapshot(7))
                .await
                .unwrap(),
            7,
        );
        let installed = store.load().expect("initial snapshot");
        let public_key = parse_authorized_key(ALICE_KEY).expect("expected public key");
        let route = resolve_owned_route(&installed, "alice.solo").expect("expected route");
        let (connection, main_registration) =
            runtime.register_connection("127.0.0.1:2206".parse().unwrap());
        connection.set_authenticated("alice.solo", &public_key, &route);
        let connection_task = tokio::spawn(Abortable::new(
            std::future::pending::<()>(),
            main_registration,
        ));

        let error = install_backend_snapshot(&store, &runtime, invalid)
            .await
            .expect_err("invalid key snapshot must fail before ACK");

        assert!(error.to_string().contains(expected_error), "{error:#}");
        assert!(store.load().is_none());
        assert_eq!(runtime.last_snapshot_generation.load(Ordering::Relaxed), 0);
        assert!(
            tokio::time::timeout(Duration::from_millis(100), connection_task)
                .await
                .expect("current connection was not revoked")
                .expect("connection task join")
                .is_err()
        );
        runtime.unregister_connection(&connection.id);
    }

    #[tokio::test]
    async fn snapshot_deadline_expires_and_revokes_without_a_status_tick() {
        let config = ProxyConfig {
            backend_ws: "ws://backend.invalid".to_string(),
            token: "a".repeat(32),
            listen: "127.0.0.1:2222".to_string(),
            max_connections: 8,
            reconnect_delay: Duration::from_secs(1),
            route_connect_timeout: Duration::from_secs(1),
            status_interval: Duration::from_millis(MAX_STATUS_INTERVAL_MS),
        };
        let store = Arc::new(SnapshotStore::default());
        let runtime = Arc::new(ProxyRuntime::new(&config));
        let mut snapshot = fixture_proxy_snapshot(7);
        snapshot.valid_until = now_ms() + 30;
        assert!(store.store(snapshot).unwrap());
        runtime.mark_snapshot(7);

        let installed = store.load().expect("snapshot");
        let public_key = parse_authorized_key(ALICE_KEY).expect("expected public key");
        let route = resolve_owned_route(&installed, "alice.solo").expect("expected route");
        let (connection, main_registration) =
            runtime.register_connection("127.0.0.1:2204".parse().unwrap());
        connection.set_authenticated("alice.solo", &public_key, &route);
        let connection_task = tokio::spawn(Abortable::new(
            std::future::pending::<()>(),
            main_registration,
        ));
        let expiry_task = tokio::spawn(run_snapshot_expiry(store.clone(), runtime.clone()));

        tokio::time::timeout(Duration::from_secs(1), async {
            while store.load().is_some() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("independent snapshot deadline did not expire");

        assert_eq!(runtime.last_snapshot_generation.load(Ordering::Relaxed), 0);
        assert!(
            tokio::time::timeout(Duration::from_millis(100), connection_task)
                .await
                .expect("authenticated session was not revoked at the lease deadline")
                .expect("connection task join")
                .is_err()
        );
        expiry_task.abort();
        let _ = expiry_task.await;
    }

    #[test]
    fn authenticated_connection_revalidation_is_semantic_and_fail_closed() {
        let public_key = parse_authorized_key(ALICE_KEY).expect("expected public key");
        let initial = fixture_snapshot();
        let route = resolve_owned_route(&initial, "alice.solo").expect("expected route");
        let (connection, _abort_registration) =
            ConnectionState::new(1, "127.0.0.1:2222".parse().unwrap());
        connection.set_authenticated("alice.solo", &public_key, &route);
        assert!(connection.authorization_matches(Some(&initial)));

        // A generation-only refresh with the same authorization tuple keeps
        // the session, avoiding periodic full-report disconnect storms.
        let same_authorization = RoutingSnapshot::from_snapshot(fixture_proxy_snapshot(8)).unwrap();
        assert!(connection.authorization_matches(Some(&same_authorization)));

        let mut rotated = fixture_proxy_snapshot(9);
        rotated.users[0].internal_key_generation = 2;
        rotated
            .routes
            .iter_mut()
            .find(|route| route.container_id == "container-c")
            .unwrap()
            .applied_internal_key_generation = Some(2);
        let rotated = RoutingSnapshot::from_snapshot(rotated).unwrap();
        assert!(!connection.authorization_matches(Some(&rotated)));

        let mut public_key_removed = fixture_proxy_snapshot(10);
        public_key_removed.users[0].public_keys.clear();
        assert!(!connection.authorization_matches(Some(
            &RoutingSnapshot::from_snapshot(public_key_removed).unwrap(),
        )));

        let mut user_disabled = fixture_proxy_snapshot(11);
        user_disabled.users[0].status = "disabled".to_string();
        assert!(!connection.authorization_matches(Some(
            &RoutingSnapshot::from_snapshot(user_disabled).unwrap(),
        )));

        let mut image_disabled = fixture_proxy_snapshot(12);
        image_disabled
            .images
            .iter_mut()
            .find(|image| image.id == "image-a")
            .unwrap()
            .disable_ssh = true;
        assert!(!connection.authorization_matches(Some(
            &RoutingSnapshot::from_snapshot(image_disabled).unwrap(),
        )));

        let mut route_removed = fixture_proxy_snapshot(13);
        route_removed
            .routes
            .retain(|route| route.container_id != "container-c");
        assert!(!connection.authorization_matches(Some(
            &RoutingSnapshot::from_snapshot(route_removed).unwrap(),
        )));
        assert!(!connection.authorization_matches(None));
    }

    #[tokio::test]
    async fn revoked_connections_abort_directly_without_protocol_backpressure() {
        let config = ProxyConfig {
            backend_ws: "ws://backend.invalid".to_string(),
            token: "test".to_string(),
            listen: "127.0.0.1:2222".to_string(),
            max_connections: 8,
            reconnect_delay: Duration::from_secs(1),
            route_connect_timeout: Duration::from_secs(1),
            status_interval: Duration::from_secs(1),
        };
        let runtime = ProxyRuntime::new(&config);
        let snapshot = fixture_snapshot();
        let public_key = parse_authorized_key(ALICE_KEY).expect("expected public key");
        let route = resolve_owned_route(&snapshot, "alice.solo").expect("expected route");

        let (first, first_registration) =
            runtime.register_connection("127.0.0.1:2201".parse().unwrap());
        first.set_authenticated("alice.solo", &public_key, &route);
        let (second, second_registration) =
            runtime.register_connection("127.0.0.1:2202".parse().unwrap());
        second.set_authenticated("alice.solo", &public_key, &route);

        // These futures model connection tasks whose graceful protocol send
        // would never finish. Revocation cancels their owning tasks directly.
        let first_task = tokio::spawn(Abortable::new(
            std::future::pending::<()>(),
            first_registration,
        ));
        let second_task = tokio::spawn(Abortable::new(
            std::future::pending::<()>(),
            second_registration,
        ));
        struct DropFlag(Arc<AtomicBool>);
        impl Drop for DropFlag {
            fn drop(&mut self) {
                self.0.store(true, Ordering::Release);
            }
        }
        let child_dropped = Arc::new(AtomicBool::new(false));
        let child_drop_flag = child_dropped.clone();
        spawn_connection_task(first.clone(), async move {
            let _drop_flag = DropFlag(child_drop_flag);
            std::future::pending::<()>().await;
        });
        tokio::task::yield_now().await;

        let disconnected = tokio::time::timeout(
            Duration::from_millis(100),
            runtime.disconnect_invalid(None, "authorization revoked"),
        )
        .await
        .expect("revocation must not wait on a client");
        assert_eq!(disconnected, 2);
        assert_eq!(
            runtime.disconnect_invalid(None, "duplicate revoke").await,
            0
        );

        assert!(tokio::time::timeout(Duration::from_millis(100), first_task)
            .await
            .expect("first task must abort")
            .expect("first join must succeed")
            .is_err());
        assert!(
            tokio::time::timeout(Duration::from_millis(100), second_task)
                .await
                .expect("second task must abort")
                .expect("second join must succeed")
                .is_err()
        );
        tokio::time::timeout(Duration::from_millis(100), async {
            while !child_dropped.load(Ordering::Acquire) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("revocation must abort spawned channel tasks");
    }

    #[tokio::test]
    async fn blocked_control_write_times_out_and_control_revocation_aborts_sessions() {
        let config = ProxyConfig {
            backend_ws: "ws://backend.invalid".to_string(),
            token: "test".to_string(),
            listen: "127.0.0.1:2222".to_string(),
            max_connections: 8,
            reconnect_delay: Duration::from_secs(1),
            route_connect_timeout: Duration::from_secs(1),
            status_interval: Duration::from_secs(1),
        };
        let runtime = ProxyRuntime::new(&config);
        let store = SnapshotStore::default();
        assert!(store.store(fixture_proxy_snapshot(7)).unwrap());
        let snapshot = store.load().expect("snapshot");
        let public_key = parse_authorized_key(ALICE_KEY).expect("expected public key");
        let route = resolve_owned_route(&snapshot, "alice.solo").expect("expected route");
        let (connection, abort_registration) =
            runtime.register_connection("127.0.0.1:2203".parse().unwrap());
        connection.set_authenticated("alice.solo", &public_key, &route);
        let connection_task = tokio::spawn(Abortable::new(
            std::future::pending::<()>(),
            abort_registration,
        ));

        let mut sink = NeverReadySink;
        tokio::time::timeout(
            Duration::from_millis(100),
            send_control_frame(
                &mut sink,
                Message::Text("blocked".into()),
                Duration::from_millis(20),
            ),
        )
        .await
        .expect("control write deadline must be bounded")
        .expect_err("never-ready sink must time out");

        revoke_control_plane(&store, &runtime, "control write timeout").await;
        assert!(store.load().is_none());
        assert!(
            tokio::time::timeout(Duration::from_millis(100), connection_task)
                .await
                .expect("connection task must abort")
                .expect("connection join must succeed")
                .is_err()
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

    fn assert_rejects(actual: RouteResolution<'_>, expected: RejectReason) {
        match actual {
            RouteResolution::Rejected(reason) => assert_eq!(reason, expected),
            RouteResolution::Accepted(route) => panic!("expected rejection, got {route:?}"),
        }
    }

    fn fixture_snapshot() -> RoutingSnapshot {
        RoutingSnapshot::from_snapshot(fixture_proxy_snapshot(7)).unwrap()
    }

    fn fixture_proxy_snapshot(generation: u64) -> ProxySnapshot {
        ProxySnapshot {
            generation,
            stale_after_ms: 300_000,
            valid_until: now_ms() + 300_000,
            host_key: ProxyHostKey {
                private_key: TEST_PRIVATE_KEY.to_string(),
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
                    internal_private_key: TEST_PRIVATE_KEY.to_string(),
                    internal_public_key: "ssh-ed25519 INTERNAL".to_string(),
                    internal_key_fingerprint: "SHA256:internal".to_string(),
                    internal_key_generation: 1,
                },
                ProxyUser {
                    id: "user-b".to_string(),
                    username: "disabled".to_string(),
                    status: "disabled".to_string(),
                    public_keys: vec![],
                    internal_private_key: TEST_PRIVATE_KEY.to_string(),
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
                    online: true,
                },
                ProxyServer {
                    id: "server-b".to_string(),
                    slug: "cpu-b".to_string(),
                    name: "CPU B".to_string(),
                    online: true,
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
        }
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
            container_host_key_fingerprint: Some(
                "SHA256:UCUiLr7Pjs9wFFJMDByLgc3NrtdU344OgUM45wZPcIQ".to_string(),
            ),
            observed_at: "2026-06-08T00:00:00.000Z".to_string(),
        }
    }

    #[test]
    fn bounds_snapshot_lease_for_fail_closed_control_loss() {
        assert!(!valid_snapshot_stale_after_ms(
            SSH_PROXY_SNAPSHOT_STALE_MIN_MS - 1
        ));
        assert!(valid_snapshot_stale_after_ms(
            SSH_PROXY_SNAPSHOT_STALE_MIN_MS
        ));
        assert!(valid_snapshot_stale_after_ms(
            SSH_PROXY_SNAPSHOT_STALE_MAX_MS
        ));
        assert!(!valid_snapshot_stale_after_ms(
            SSH_PROXY_SNAPSHOT_STALE_MAX_MS + 1
        ));
    }
}
