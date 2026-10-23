use crate::config::ProxyConfig;
use crate::session::OwnedResolvedRoute;
use crate::snapshot::RoutingSnapshot;
use futures_util::future::{AbortHandle, AbortRegistration, Abortable};
use proxy_common::clock::now_ms;
use proxy_common::conn_limit::PendingPermit;
use russh::keys::PublicKey;
use serde::Serialize;
use std::collections::HashMap;
use std::future::Future;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tracing::debug;

pub(crate) const MAX_CHANNELS_PER_CONNECTION: usize = 16;

pub(crate) const MAX_CHILD_TASKS_PER_CONNECTION: usize = 64;

/// Upper bound on the serialized per-connection details in one status frame.
/// The Backend closes control frames over 1 MiB (code 1009); the rest of the
/// report is a few hundred bytes, so this leaves ample headroom.
pub(crate) const MAX_STATUS_CONNECTION_DETAIL_BYTES: usize = 512 * 1024;

/// Mirrors `MAX_SSH_PROXY_STATUS_CONNECTIONS` in `@nyabase/common`.
pub(crate) const MAX_STATUS_CONNECTION_DETAILS: usize = 1024;

pub(crate) struct ProxyRuntime {
    pub(crate) proxy_id: String,
    pub(crate) hostname: Option<String>,
    pub(crate) listen: String,
    pub(crate) started_at: Instant,
    pub(crate) backend_connected_at: AtomicU64,
    pub(crate) last_snapshot_generation: AtomicU64,
    pub(crate) last_snapshot_at: AtomicU64,
    pub(crate) total_connections: AtomicU64,
    pub(crate) total_rejected_connections: AtomicU64,
    pub(crate) total_closed_connections: AtomicU64,
    pub(crate) total_bytes_from_client: AtomicU64,
    pub(crate) total_bytes_to_client: AtomicU64,
    pub(crate) connections: Mutex<HashMap<String, Arc<ConnectionState>>>,
    pub(crate) bandwidth: Mutex<BandwidthState>,
}

pub(crate) struct BandwidthState {
    pub(crate) last_ts: u64,
    pub(crate) last_in: u64,
    pub(crate) last_out: u64,
    pub(crate) in_bps: f64,
    pub(crate) out_bps: f64,
}

pub(crate) struct ConnectionState {
    pub(crate) id: String,
    pub(crate) peer: String,
    pub(crate) connected_at: u64,
    pub(crate) authenticated_at: AtomicU64,
    pub(crate) bytes_from_client: AtomicU64,
    pub(crate) bytes_to_client: AtomicU64,
    pub(crate) channels: AtomicUsize,
    pub(crate) login: Mutex<Option<String>>,
    pub(crate) authenticated_public_key: Mutex<Option<PublicKey>>,
    pub(crate) authenticated_user_id: Mutex<Option<String>>,
    pub(crate) authenticated_username: Mutex<Option<String>>,
    /// Most recent route (login-pinned or last bridged), for status display only.
    pub(crate) route: Mutex<Option<ConnectionRouteInfo>>,
    /// Route bound by a jump-format login; revoking it ends the connection.
    pub(crate) pinned_route: Mutex<Option<ConnectionRouteInfo>>,
    /// Route of every live direct-tcpip bridge, keyed by its child task id.
    /// Each is revalidated on every snapshot and closed on its own.
    pub(crate) bridge_routes: Mutex<HashMap<u64, ConnectionRouteInfo>>,
    /// Pre-authentication slot from the listener; released on authentication.
    pub(crate) pending_permit: Mutex<Option<PendingPermit>>,
    pub(crate) abort_handle: AbortHandle,
    pub(crate) revoked: AtomicBool,
    pub(crate) next_child_id: AtomicU64,
    pub(crate) child_abort_handles: Mutex<HashMap<u64, AbortHandle>>,
}

pub(crate) struct ChildTaskPermit {
    pub(crate) connection: Arc<ConnectionState>,
    pub(crate) id: Option<u64>,
    pub(crate) registration: Option<AbortRegistration>,
}

pub(crate) struct ChildTaskCleanup {
    pub(crate) connection: Arc<ConnectionState>,
    pub(crate) id: u64,
}

impl Drop for ChildTaskCleanup {
    fn drop(&mut self) {
        self.connection.unregister_child_abort(self.id);
    }
}

impl ChildTaskPermit {
    /// Records the route this child bridges to, so snapshot revalidation can
    /// close this child alone when that route is revoked. Done before the
    /// caller's final authorization check, so no snapshot can slip between.
    pub(crate) fn bind_route(&self, route: &OwnedResolvedRoute) {
        if let Some(id) = self.id {
            lock(&self.connection.bridge_routes).insert(id, ConnectionRouteInfo::from(route));
        }
    }

    pub(crate) fn spawn<F>(mut self, future: F)
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
pub(crate) struct ConnectionRouteInfo {
    pub(crate) user_id: String,
    pub(crate) username: String,
    pub(crate) server_id: String,
    pub(crate) server_slug: String,
    pub(crate) container_id: String,
    pub(crate) container_name: String,
    pub(crate) instance_name: String,
    pub(crate) routed_ip: String,
}

impl From<&OwnedResolvedRoute> for ConnectionRouteInfo {
    fn from(route: &OwnedResolvedRoute) -> Self {
        Self {
            user_id: route.user_id.clone(),
            username: route.username.clone(),
            server_id: route.server_id.clone(),
            server_slug: route.server_slug.clone(),
            container_id: route.container_id.clone(),
            container_name: route.container_name.clone(),
            instance_name: route.instance_name.clone(),
            routed_ip: route.routed_ip.clone(),
        }
    }
}

impl ConnectionRouteInfo {
    pub(crate) fn still_authorized(&self, snapshot: &RoutingSnapshot) -> bool {
        snapshot
            .resolve_owned_route_for_user_ip(&self.user_id, &self.routed_ip)
            .is_ok_and(|current| self.matches(&current))
    }

    pub(crate) fn matches(&self, route: &OwnedResolvedRoute) -> bool {
        self.user_id == route.user_id
            && self.username == route.username
            && self.server_id == route.server_id
            && self.server_slug == route.server_slug
            && self.container_id == route.container_id
            && self.container_name == route.container_name
            && self.instance_name == route.instance_name
            && self.routed_ip == route.routed_ip
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SshProxyStatusReport {
    pub(crate) proxy_id: String,
    pub(crate) hostname: Option<String>,
    pub(crate) listen: String,
    pub(crate) uptime_ms: u64,
    pub(crate) connected_at: u64,
    pub(crate) last_snapshot_generation: Option<u64>,
    pub(crate) last_snapshot_at: Option<u64>,
    pub(crate) active_connections: usize,
    /// Connections counted in `active_connections` but left out of
    /// `connections` to keep the frame bounded.
    pub(crate) omitted_connections: usize,
    pub(crate) total_connections: u64,
    pub(crate) total_rejected_connections: u64,
    pub(crate) total_closed_connections: u64,
    pub(crate) total_bytes_from_client: u64,
    pub(crate) total_bytes_to_client: u64,
    pub(crate) bandwidth_in_bps: f64,
    pub(crate) bandwidth_out_bps: f64,
    pub(crate) connections: Vec<SshProxyConnectionInfo>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SshProxyConnectionInfo {
    pub(crate) id: String,
    pub(crate) peer: String,
    pub(crate) username: Option<String>,
    pub(crate) login: Option<String>,
    pub(crate) server_slug: Option<String>,
    pub(crate) server_id: Option<String>,
    pub(crate) container_name: Option<String>,
    pub(crate) container_id: Option<String>,
    pub(crate) instance_name: Option<String>,
    pub(crate) routed_ip: Option<String>,
    pub(crate) connected_at: u64,
    pub(crate) authenticated_at: Option<u64>,
    pub(crate) bytes_from_client: u64,
    pub(crate) bytes_to_client: u64,
    pub(crate) channels: usize,
}

impl ProxyRuntime {
    pub(crate) fn new(config: &ProxyConfig) -> Self {
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

    pub(crate) fn mark_backend_connected(&self) {
        self.backend_connected_at.store(now_ms(), Ordering::Relaxed);
    }

    pub(crate) fn mark_snapshot(&self, generation: u64) {
        self.last_snapshot_generation
            .store(generation, Ordering::Relaxed);
        self.last_snapshot_at.store(now_ms(), Ordering::Relaxed);
    }

    pub(crate) fn clear_snapshot(&self) {
        self.last_snapshot_generation.store(0, Ordering::Relaxed);
        self.last_snapshot_at.store(0, Ordering::Relaxed);
    }

    pub(crate) fn record_rejected_connection(&self) {
        self.total_rejected_connections
            .fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn register_connection(
        &self,
        peer: SocketAddr,
    ) -> (Arc<ConnectionState>, AbortRegistration) {
        let sequence = self.total_connections.fetch_add(1, Ordering::Relaxed) + 1;
        let (connection, abort_registration) = ConnectionState::new(sequence, peer);
        let connection = Arc::new(connection);
        lock(&self.connections).insert(connection.id.clone(), connection.clone());
        (connection, abort_registration)
    }

    pub(crate) fn unregister_connection(&self, id: &str) {
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

    pub(crate) async fn disconnect_all(&self, reason: &str) -> usize {
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

    pub(crate) async fn abort_unauthenticated(&self, reason: &str) -> usize {
        let connections = {
            let connections = lock(&self.connections);
            connections
                .values()
                .filter(|connection| connection.authenticated_at.load(Ordering::Relaxed) == 0)
                .cloned()
                .collect::<Vec<_>>()
        };
        let aborted = connections
            .into_iter()
            .filter(|connection| connection.abort())
            .count();
        debug!(aborted, %reason, "aborted unauthenticated SSH proxy connections");
        aborted
    }

    pub(crate) async fn disconnect_invalid(
        &self,
        snapshot: Option<&RoutingSnapshot>,
        reason: &str,
    ) -> usize {
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
        let closed_bridges = match snapshot {
            Some(snapshot) => {
                let survivors = lock(&self.connections)
                    .values()
                    .cloned()
                    .collect::<Vec<_>>();
                survivors
                    .iter()
                    .map(|connection| connection.abort_revoked_bridges(snapshot))
                    .sum::<usize>()
            }
            None => 0,
        };
        debug!(disconnected, closed_bridges, %reason, "aborted revoked SSH proxy connections");
        disconnected
    }

    pub(crate) fn status_report(&self) -> SshProxyStatusReport {
        let mut connections = {
            let connections = lock(&self.connections);
            connections
                .values()
                .map(|connection| connection.snapshot())
                .collect::<Vec<_>>()
        };
        connections.sort_by_key(|connection| connection.connected_at);
        let active_connections = connections.len();
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
            active_connections,
            omitted_connections: 0,
            total_connections: self.total_connections.load(Ordering::Relaxed),
            total_rejected_connections: self.total_rejected_connections.load(Ordering::Relaxed),
            total_closed_connections: self.total_closed_connections.load(Ordering::Relaxed),
            total_bytes_from_client,
            total_bytes_to_client,
            bandwidth_in_bps,
            bandwidth_out_bps,
            connections,
        }
        .bounded(
            MAX_STATUS_CONNECTION_DETAILS,
            MAX_STATUS_CONNECTION_DETAIL_BYTES,
        )
    }

    pub(crate) fn bandwidth(&self, total_in: u64, total_out: u64) -> (f64, f64) {
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

impl SshProxyStatusReport {
    /// Keeps the oldest connection details that fit both bounds and counts
    /// the rest in `omitted_connections`, so no number or size of client
    /// connections can push the status frame over the Backend's limit.
    pub(crate) fn bounded(mut self, max_entries: usize, max_bytes: usize) -> Self {
        let mut used = 0_usize;
        let mut kept = 0_usize;
        for connection in self.connections.iter().take(max_entries) {
            let size = serde_json::to_vec(connection)
                .map(|encoded| encoded.len() + 1)
                .unwrap_or(usize::MAX);
            if size > max_bytes.saturating_sub(used) {
                break;
            }
            used += size;
            kept += 1;
        }
        self.connections.truncate(kept);
        self.omitted_connections = self.active_connections - kept;
        self
    }
}

pub(crate) struct ConnectionCleanup {
    pub(crate) runtime: Arc<ProxyRuntime>,
    pub(crate) id: String,
}

impl Drop for ConnectionCleanup {
    fn drop(&mut self) {
        self.runtime.unregister_connection(&self.id);
    }
}

impl ConnectionState {
    pub(crate) fn new(sequence: u64, peer: SocketAddr) -> (Self, AbortRegistration) {
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
                authenticated_user_id: Mutex::new(None),
                authenticated_username: Mutex::new(None),
                route: Mutex::new(None),
                pinned_route: Mutex::new(None),
                bridge_routes: Mutex::new(HashMap::new()),
                pending_permit: Mutex::new(None),
                abort_handle,
                revoked: AtomicBool::new(false),
                next_child_id: AtomicU64::new(1),
                child_abort_handles: Mutex::new(HashMap::new()),
            },
            abort_registration,
        )
    }

    pub(crate) fn abort(&self) -> bool {
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

    pub(crate) fn register_child_abort(&self, handle: AbortHandle) -> Option<u64> {
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

    pub(crate) fn try_reserve_child_task(self: &Arc<Self>) -> Option<ChildTaskPermit> {
        let (abort_handle, registration) = AbortHandle::new_pair();
        let id = self.register_child_abort(abort_handle)?;
        Some(ChildTaskPermit {
            connection: self.clone(),
            id: Some(id),
            registration: Some(registration),
        })
    }

    pub(crate) fn unregister_child_abort(&self, id: u64) {
        lock(&self.child_abort_handles).remove(&id);
        lock(&self.bridge_routes).remove(&id);
    }

    /// Holds the listener's pre-authentication slot until authentication.
    pub(crate) fn hold_pending(&self, permit: Option<PendingPermit>) {
        *lock(&self.pending_permit) = permit;
    }

    /// Closes every bridge whose container route is no longer authorized by
    /// `snapshot`, leaving the connection and its other bridges open.
    pub(crate) fn abort_revoked_bridges(&self, snapshot: &RoutingSnapshot) -> usize {
        let revoked = lock(&self.bridge_routes)
            .iter()
            .filter(|(_, route)| !route.still_authorized(snapshot))
            .map(|(id, _)| *id)
            .collect::<Vec<_>>();
        for id in &revoked {
            lock(&self.bridge_routes).remove(id);
            if let Some(handle) = lock(&self.child_abort_handles).remove(id) {
                handle.abort();
            }
        }
        revoked.len()
    }

    pub(crate) fn set_authenticated(
        &self,
        login: &str,
        public_key: &PublicKey,
        user_id: &str,
        username: &str,
        route: Option<&OwnedResolvedRoute>,
    ) {
        *lock(&self.login) = Some(login.to_string());
        *lock(&self.authenticated_public_key) = Some(public_key.clone());
        *lock(&self.authenticated_user_id) = Some(user_id.to_string());
        *lock(&self.authenticated_username) = Some(username.to_string());
        let route = route.map(ConnectionRouteInfo::from);
        *lock(&self.pinned_route) = route.clone();
        *lock(&self.route) = route;
        self.authenticated_at.store(now_ms(), Ordering::Relaxed);
        lock(&self.pending_permit).take();
    }

    /// Updates the route shown in status reports; authorization of bridged
    /// routes is tracked per bridge (`ChildTaskPermit::bind_route`).
    pub(crate) fn set_display_route(&self, route: &OwnedResolvedRoute) {
        *lock(&self.route) = Some(ConnectionRouteInfo::from(route));
    }

    pub(crate) fn authorization_matches(&self, snapshot: Option<&RoutingSnapshot>) -> bool {
        let login = lock(&self.login).clone();
        if login.is_none() {
            // Pre-authentication sessions re-read SnapshotStore on every auth
            // callback, so there is no pinned authorization to revoke here.
            return true;
        }
        let Some(snapshot) = snapshot else {
            return false;
        };
        let Some(public_key) = lock(&self.authenticated_public_key).clone() else {
            return false;
        };
        let Some(user_id) = lock(&self.authenticated_user_id).clone() else {
            return false;
        };
        let Ok(user) = snapshot.find_active_user_by_public_key(&public_key) else {
            return false;
        };
        if user.id != user_id {
            return false;
        }
        if let Some(expected) = lock(&self.pinned_route).clone() {
            return expected.user_id == user_id && expected.still_authorized(snapshot);
        }
        true
    }

    pub(crate) fn record_from_client(&self, bytes: usize) {
        self.bytes_from_client
            .fetch_add(bytes as u64, Ordering::Relaxed);
    }

    pub(crate) fn record_to_client(&self, bytes: usize) {
        self.bytes_to_client
            .fetch_add(bytes as u64, Ordering::Relaxed);
    }

    pub(crate) fn channel_opened(&self) {
        self.channels.fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn channel_closed(&self) {
        let _ = self
            .channels
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                value.checked_sub(1)
            });
    }

    pub(crate) fn snapshot(&self) -> SshProxyConnectionInfo {
        let route = lock(&self.route).clone();
        let authenticated_at = nonzero(self.authenticated_at.load(Ordering::Relaxed));
        SshProxyConnectionInfo {
            id: self.id.clone(),
            peer: self.peer.clone(),
            username: route
                .as_ref()
                .map(|route| route.username.clone())
                .or_else(|| lock(&self.authenticated_username).clone()),
            login: lock(&self.login).clone(),
            server_slug: route.as_ref().map(|route| route.server_slug.clone()),
            server_id: route.as_ref().map(|route| route.server_id.clone()),
            container_name: route.as_ref().map(|route| route.container_name.clone()),
            container_id: route.as_ref().map(|route| route.container_id.clone()),
            instance_name: route.as_ref().map(|route| route.instance_name.clone()),
            routed_ip: route.as_ref().map(|route| route.routed_ip.clone()),
            connected_at: self.connected_at,
            authenticated_at,
            bytes_from_client: self.bytes_from_client.load(Ordering::Relaxed),
            bytes_to_client: self.bytes_to_client.load(Ordering::Relaxed),
            channels: self.channels.load(Ordering::Relaxed),
        }
    }
}

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn nonzero(value: u64) -> Option<u64> {
    if value == 0 {
        None
    } else {
        Some(value)
    }
}

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;
