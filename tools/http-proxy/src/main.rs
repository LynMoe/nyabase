use std::collections::HashMap;
use std::ffi::OsString;
use std::fs::OpenOptions;
use std::future::Future;
use std::io::{BufReader, Read};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

use anyhow::{anyhow, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use rustls::pki_types::CertificateDer;
use rustls::server::{ClientHello, ResolvesServerCert};
use rustls::sign::CertifiedKey;
use serde::{Deserialize, Serialize};
use tokio::io::{self, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch, OwnedSemaphorePermit, Semaphore};
use tokio::task::JoinSet;
use tokio::time;
use tokio_rustls::TlsAcceptor;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Error as WebSocketError;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async_tls_with_config, Connector};
use tracing::{debug, info, warn};

const MAX_REQUEST_HEADER_BYTES: usize = 64 * 1024;
const MAX_UPSTREAM_UPGRADE_HEADER_BYTES: usize = 64 * 1024;
const MAX_REQUEST_BODY_BYTES: usize = 16 * 1024 * 1024;
const REQUEST_HEADER_DEADLINE: Duration = Duration::from_secs(10);
const UPSTREAM_CONNECT_DEADLINE: Duration = Duration::from_secs(10);
const UPSTREAM_UPGRADE_HEADER_DEADLINE: Duration = Duration::from_secs(10);
const REQUEST_LIFETIME_DEADLINE: Duration = Duration::from_secs(120);
const CONTROL_WRITE_DEADLINE: Duration = Duration::from_secs(5);
const TLS_HANDSHAKE_DEADLINE: Duration = Duration::from_secs(10);
const MAX_SNAPSHOT_STALE_AFTER_MS: u64 = 300_000;
const MAX_SNAPSHOT_CLOCK_SKEW_MS: u64 = 30_000;
const MIN_CONTROL_TOKEN_BYTES: usize = 32;
const MAX_CONTROL_TOKEN_BYTES: usize = 1024;
const MIN_STATUS_INTERVAL_MS: u64 = 250;
const MAX_STATUS_INTERVAL_MS: u64 = 60_000;
// A request may retain up to 16 MiB of body data. Keep the fixed global
// connection cap deliberately small so the worst-case resident set remains
// finite and operationally reasonable without another buffering subsystem.
const MAX_ACTIVE_CONNECTIONS: usize = 32;
const MAX_BACKEND_CA_PEM_BYTES: u64 = 1024 * 1024;

#[derive(Clone)]
struct Config {
    backend_ws: String,
    backend_tls: Option<Arc<rustls::ClientConfig>>,
    token: String,
    http_listen: String,
    https_listen: Option<String>,
    max_connections: usize,
    reconnect_delay: Duration,
    status_interval: Duration,
}

impl Config {
    fn from_env() -> Result<Self> {
        let backend_ws = std::env::var("NYABASE_BACKEND_WS")
            .unwrap_or_else(|_| "ws://127.0.0.1:3000/ws/http-proxy".to_string());
        let backend_tls = backend_tls_config_from_env("NYABASE_BACKEND_CA_FILE")?;
        validate_backend_ws_url(&backend_ws, backend_tls.is_some())?;
        let token = required_control_token("HTTP_PROXY_TOKEN", "HTTP_PROXY_TOKEN_FILE")?;
        let http_listen =
            std::env::var("NYABASE_HTTP_LISTEN").unwrap_or_else(|_| "0.0.0.0:8080".to_string());
        let https_listen = std::env::var("NYABASE_HTTPS_LISTEN")
            .ok()
            .filter(|value| !value.trim().is_empty());
        let max_connections = validate_connection_cap(env_usize(
            "NYABASE_HTTP_MAX_CONNECTIONS",
            MAX_ACTIVE_CONNECTIONS,
        )?)?;
        let reconnect_delay =
            Duration::from_millis(env_u64("NYABASE_BACKEND_RECONNECT_MS", 2_000)?);
        let status_interval =
            validate_status_interval(env_u64("NYABASE_HTTP_STATUS_INTERVAL_MS", 1_000)?)?;
        Ok(Self {
            backend_ws,
            backend_tls,
            token,
            http_listen,
            https_listen,
            max_connections,
            reconnect_delay,
            status_interval,
        })
    }
}

#[derive(Debug)]
struct SnapshotStore {
    state: Mutex<SnapshotState>,
    revision: AtomicU64,
    changes: watch::Sender<u64>,
}

#[derive(Debug)]
struct SnapshotState {
    current: Option<Arc<RoutingSnapshot>>,
    generation_high_water: Option<u64>,
    control_epoch: Arc<()>,
    authorization_epoch: Arc<()>,
}

impl Default for SnapshotState {
    fn default() -> Self {
        Self {
            current: None,
            generation_high_water: None,
            control_epoch: Arc::new(()),
            authorization_epoch: Arc::new(()),
        }
    }
}

#[derive(Clone, Debug)]
struct SnapshotLease {
    generation: u64,
    deadline: Instant,
    control_epoch: Arc<()>,
}

#[derive(Clone, Debug)]
struct RouteAuthorization {
    route: Route,
    authorization_epoch: Arc<()>,
}

impl Default for SnapshotStore {
    fn default() -> Self {
        let (changes, _) = watch::channel(0);
        Self {
            state: Mutex::new(SnapshotState::default()),
            revision: AtomicU64::new(0),
            changes,
        }
    }
}

impl SnapshotStore {
    fn store(&self, snapshot: ProxySnapshot) -> Result<Option<SnapshotLease>> {
        let generation = snapshot.generation;
        let received_at = Instant::now();
        let routing = Arc::new(RoutingSnapshot::from_received(snapshot, received_at)?);
        if !routing.is_fresh(Instant::now()) {
            return Err(anyhow!(
                "HTTP proxy snapshot lease expired before installation"
            ));
        }
        let mut state = self.lock_state();
        let expired = state
            .current
            .as_ref()
            .is_some_and(|current| !current.is_fresh(received_at));
        if expired {
            state.current = None;
            state.authorization_epoch = Arc::new(());
        }
        if state
            .generation_high_water
            .is_some_and(|current| current >= generation)
        {
            drop(state);
            if expired {
                self.signal_change();
            }
            warn!(generation, "rejected non-increasing HTTP proxy snapshot");
            return Ok(None);
        }
        let contracts_authority = state.current.as_ref().is_some_and(|current| {
            current.routes.values().any(|old_route| {
                routing
                    .routes
                    .get(&old_route.hostname)
                    .is_none_or(|new_route| !new_route.same_authority(old_route))
            })
        });
        if contracts_authority {
            state.authorization_epoch = Arc::new(());
        }
        let lease = SnapshotLease {
            generation,
            deadline: routing.deadline,
            control_epoch: state.control_epoch.clone(),
        };
        let route_count = routing.routes.len();
        state.current = Some(routing);
        state.generation_high_water = Some(generation);
        drop(state);
        self.signal_change();
        info!(generation, route_count, "installed HTTP proxy snapshot");
        Ok(Some(lease))
    }

    fn load(&self) -> Option<Arc<RoutingSnapshot>> {
        let now = Instant::now();
        let mut state = self.lock_state();
        let expired = state
            .current
            .as_ref()
            .is_some_and(|current| !current.is_fresh(now));
        if expired {
            state.current = None;
            state.authorization_epoch = Arc::new(());
        }
        let current = state.current.clone();
        drop(state);
        if expired {
            self.signal_change();
        }
        current
    }

    fn expire(&self, lease: SnapshotLease) -> bool {
        let now = Instant::now();
        let mut state = self.lock_state();
        let should_expire = state.current.as_ref().is_some_and(|current| {
            Arc::ptr_eq(&state.control_epoch, &lease.control_epoch)
                && current.generation == lease.generation
                && current.deadline == lease.deadline
                && !current.is_fresh(now)
        });
        if should_expire {
            state.current = None;
            state.authorization_epoch = Arc::new(());
        }
        drop(state);
        if should_expire {
            self.signal_change();
            warn!(
                generation = lease.generation,
                "HTTP proxy snapshot lease expired"
            );
        }
        should_expire
    }

    fn clear_epoch(&self) {
        let mut state = self.lock_state();
        state.current = None;
        state.generation_high_water = None;
        state.control_epoch = Arc::new(());
        state.authorization_epoch = Arc::new(());
        drop(state);
        self.signal_change();
    }

    fn subscribe(&self) -> watch::Receiver<u64> {
        self.changes.subscribe()
    }

    #[cfg(test)]
    fn route_is_current(&self, expected: &Route) -> bool {
        self.authorize_route(&expected.hostname)
            .is_some_and(|current| current.route.same_authority(expected))
    }

    fn authorize_route(&self, hostname: &str) -> Option<RouteAuthorization> {
        let now = Instant::now();
        let mut state = self.lock_state();
        let expired = state
            .current
            .as_ref()
            .is_some_and(|current| !current.is_fresh(now));
        if expired {
            state.current = None;
            state.authorization_epoch = Arc::new(());
        }
        let authorization = state.current.as_ref().and_then(|snapshot| {
            snapshot
                .routes
                .get(hostname)
                .cloned()
                .map(|route| RouteAuthorization {
                    route,
                    authorization_epoch: state.authorization_epoch.clone(),
                })
        });
        drop(state);
        if expired {
            self.signal_change();
        }
        authorization
    }

    fn authorization_is_current(&self, expected: &RouteAuthorization) -> bool {
        self.authorization_deadline(expected).is_some()
    }

    fn authorization_deadline(&self, expected: &RouteAuthorization) -> Option<Instant> {
        let now = Instant::now();
        let mut state = self.lock_state();
        let expired = state
            .current
            .as_ref()
            .is_some_and(|current| !current.is_fresh(now));
        if expired {
            state.current = None;
            state.authorization_epoch = Arc::new(());
        }
        let deadline =
            if !expired && Arc::ptr_eq(&state.authorization_epoch, &expected.authorization_epoch) {
                state.current.as_ref().and_then(|snapshot| {
                    snapshot
                        .routes
                        .get(&expected.route.hostname)
                        .filter(|route| route.same_authority(&expected.route))
                        .map(|_| snapshot.deadline)
                })
            } else {
                None
            };
        drop(state);
        if expired {
            self.signal_change();
        }
        deadline
    }

    fn signal_change(&self) {
        let revision = self.revision.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = self.changes.send(revision);
    }

    fn lock_state(&self) -> MutexGuard<'_, SnapshotState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

struct Runtime {
    proxy_id: String,
    hostname: Option<String>,
    http_listen: String,
    https_listen: Option<String>,
    started_at: Instant,
    connected_at: AtomicU64,
    last_snapshot_generation: AtomicU64,
    last_snapshot_at: AtomicU64,
    active_connections: AtomicU64,
    total_requests: AtomicU64,
    total_rejected_requests: AtomicU64,
}

#[derive(Clone, Debug)]
struct RoutingSnapshot {
    generation: u64,
    received_at: Instant,
    deadline: Instant,
    routes: HashMap<String, Route>,
    certs: Vec<DomainCert>,
}

impl RoutingSnapshot {
    fn from_received(snapshot: ProxySnapshot, received_at: Instant) -> Result<Self> {
        if snapshot.stale_after_ms == 0 || snapshot.stale_after_ms > MAX_SNAPSHOT_STALE_AFTER_MS {
            return Err(anyhow!("invalid HTTP proxy snapshot staleAfterMs"));
        }
        let remaining = absolute_snapshot_remaining(
            snapshot.valid_until_ms,
            snapshot.stale_after_ms,
            now_ms(),
        )?;
        let deadline = received_at
            .checked_add(remaining)
            .context("HTTP proxy snapshot lease deadline overflow")?;
        let routes = snapshot
            .routes
            .into_iter()
            .map(|route| (route.hostname.clone(), route))
            .collect::<HashMap<_, _>>();
        let certs = snapshot
            .domain_pools
            .into_iter()
            .map(DomainCert::from_pool)
            .collect::<Result<Vec<_>>>()?;
        Ok(Self {
            generation: snapshot.generation,
            received_at,
            deadline,
            routes,
            certs,
        })
    }

    fn is_fresh(&self, now: Instant) -> bool {
        debug_assert!(self.deadline >= self.received_at);
        now < self.deadline
    }
}

#[derive(Clone, Debug)]
struct DomainCert {
    wildcard_domain: String,
    key: Arc<CertifiedKey>,
}

impl DomainCert {
    fn from_pool(pool: DomainPool) -> Result<Self> {
        if !is_valid_wildcard_domain(&pool.wildcard_domain) {
            return Err(anyhow!("invalid wildcard domain in HTTP TLS pool"));
        }
        let cert_pem = pool.certificate_pem.context("missing certificate")?;
        let key_pem = pool.private_key_pem.context("missing private key")?;
        let mut cert_reader = BufReader::new(cert_pem.as_bytes());
        let certs = rustls_pemfile::certs(&mut cert_reader)
            .collect::<std::result::Result<Vec<CertificateDer<'static>>, _>>()?;
        if certs.is_empty() {
            return Err(anyhow!("HTTP TLS pool contains no certificates"));
        }
        let mut key_reader = BufReader::new(key_pem.as_bytes());
        let key = rustls_pemfile::private_key(&mut key_reader)?
            .ok_or_else(|| anyhow!("missing private key"))?;
        let signing_key = rustls::crypto::ring::sign::any_supported_type(&key)?;
        let certified_key = CertifiedKey::new(certs, signing_key);
        certified_key
            .keys_match()
            .context("HTTP TLS certificate and private key do not match")?;
        Ok(Self {
            wildcard_domain: pool.wildcard_domain.to_ascii_lowercase(),
            key: Arc::new(certified_key),
        })
    }
}

#[derive(Debug)]
struct SnapshotCertResolver {
    store: Arc<SnapshotStore>,
}

impl ResolvesServerCert for SnapshotCertResolver {
    fn resolve(&self, hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        let sni = hello
            .server_name()?
            .trim_end_matches('.')
            .to_ascii_lowercase();
        let snapshot = self.store.load()?;
        snapshot
            .certs
            .iter()
            .find(|cert| hostname_matches_wildcard(&sni, &cert.wildcard_domain))
            .map(|cert| cert.key.clone())
    }
}

#[derive(Clone, Debug, Deserialize)]
struct ProxySnapshot {
    generation: u64,
    #[serde(rename = "staleAfterMs")]
    stale_after_ms: u64,
    #[serde(rename = "validUntil")]
    valid_until_ms: u64,
    routes: Vec<Route>,
    #[serde(rename = "domainPools")]
    domain_pools: Vec<DomainPool>,
}

#[derive(Clone, Debug, Deserialize)]
struct Route {
    #[serde(rename = "bindingId")]
    binding_id: String,
    hostname: String,
    #[serde(rename = "domainPoolId")]
    domain_pool_id: String,
    #[serde(rename = "ownerId")]
    owner_id: String,
    #[serde(rename = "containerId")]
    container_id: String,
    #[serde(rename = "runtimeId")]
    runtime_id: String,
    #[serde(rename = "targetIp")]
    target_ip: String,
    #[serde(rename = "targetPort")]
    target_port: u16,
}

impl Route {
    fn same_authority(&self, other: &Self) -> bool {
        self.binding_id == other.binding_id
            && self.hostname == other.hostname
            && self.domain_pool_id == other.domain_pool_id
            && self.owner_id == other.owner_id
            && self.container_id == other.container_id
            && self.runtime_id == other.runtime_id
            && self.target_ip == other.target_ip
            && self.target_port == other.target_port
    }
}

#[derive(Clone, Debug, Deserialize)]
struct DomainPool {
    #[serde(rename = "wildcardDomain")]
    wildcard_domain: String,
    #[serde(rename = "certificatePem")]
    certificate_pem: Option<String>,
    #[serde(rename = "privateKeyPem")]
    private_key_pem: Option<String>,
}

#[derive(Deserialize)]
struct Envelope {
    kind: String,
    payload: serde_json::Value,
}

#[derive(Serialize)]
struct StatusReport<'a> {
    ts: u64,
    kind: &'static str,
    payload: StatusPayload<'a>,
}

#[derive(Serialize)]
struct StatusPayload<'a> {
    #[serde(rename = "proxyId")]
    proxy_id: &'a str,
    hostname: Option<&'a str>,
    #[serde(rename = "httpListen")]
    http_listen: &'a str,
    #[serde(rename = "httpsListen")]
    https_listen: Option<&'a str>,
    #[serde(rename = "uptimeMs")]
    uptime_ms: u64,
    #[serde(rename = "connectedAt")]
    connected_at: u64,
    #[serde(rename = "lastSnapshotGeneration")]
    last_snapshot_generation: Option<u64>,
    #[serde(rename = "lastSnapshotAt")]
    last_snapshot_at: Option<u64>,
    #[serde(rename = "activeConnections")]
    active_connections: u64,
    #[serde(rename = "totalRequests")]
    total_requests: u64,
    #[serde(rename = "totalRejectedRequests")]
    total_rejected_requests: u64,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    rustls::crypto::ring::default_provider()
        .install_default()
        .ok();

    let config = Config::from_env()?;
    let store = Arc::new(SnapshotStore::default());
    let runtime = Arc::new(Runtime {
        proxy_id: format!("http-proxy-{}", now_ms()),
        hostname: std::env::var("HOSTNAME").ok(),
        http_listen: config.http_listen.clone(),
        https_listen: config.https_listen.clone(),
        started_at: Instant::now(),
        connected_at: AtomicU64::new(0),
        last_snapshot_generation: AtomicU64::new(0),
        last_snapshot_at: AtomicU64::new(0),
        active_connections: AtomicU64::new(0),
        total_requests: AtomicU64::new(0),
        total_rejected_requests: AtomicU64::new(0),
    });
    let (status_tx, status_rx) = mpsc::channel(32);
    let connection_slots = Arc::new(Semaphore::new(config.max_connections));
    let mut tasks = JoinSet::new();

    spawn_supervised(
        &mut tasks,
        "HTTP proxy control loop",
        control_loop(config.clone(), store.clone(), runtime.clone(), status_rx),
    );
    spawn_supervised(
        &mut tasks,
        "HTTP proxy status loop",
        status_loop(config.clone(), runtime.clone(), status_tx),
    );
    spawn_supervised(
        &mut tasks,
        "HTTP proxy snapshot lease loop",
        snapshot_lease_loop(store.clone()),
    );
    spawn_supervised(
        &mut tasks,
        "HTTP proxy listener",
        http_listener(
            config.http_listen.clone(),
            store.clone(),
            runtime.clone(),
            connection_slots.clone(),
            false,
        ),
    );
    if let Some(listen) = config.https_listen.clone() {
        spawn_supervised(
            &mut tasks,
            "HTTPS proxy listener",
            http_listener(listen, store, runtime, connection_slots, true),
        );
    }

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
            signal.context("failed to wait for HTTP proxy shutdown signal")?;
            Ok(())
        }
        completed = tasks.join_next() => {
            match completed {
                Some(Ok((name, Ok(())))) => Err(anyhow!("{name} exited unexpectedly")),
                Some(Ok((name, Err(error)))) => Err(error).with_context(|| format!("{name} failed")),
                Some(Err(error)) => Err(anyhow!("supervised HTTP proxy task failed: {error}")),
                None => Err(anyhow!("all supervised HTTP proxy tasks exited unexpectedly")),
            }
        }
    };
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    outcome
}

async fn control_loop(
    config: Config,
    store: Arc<SnapshotStore>,
    runtime: Arc<Runtime>,
    mut status_rx: mpsc::Receiver<String>,
) -> Result<()> {
    loop {
        // Backend restart resets snapshot generations. A connection epoch is
        // therefore the monotonicity boundary, and losing control must remove
        // all routes immediately rather than serve stale authorization state.
        store.clear_epoch();
        runtime.last_snapshot_generation.store(0, Ordering::Relaxed);
        runtime.last_snapshot_at.store(0, Ordering::Relaxed);
        match connect_control(&config, &store, &runtime, &mut status_rx).await {
            Ok(()) => warn!("HTTP proxy control connection closed"),
            Err(error) => warn!(%error, "HTTP proxy control connection failed"),
        }
        store.clear_epoch();
        runtime.last_snapshot_generation.store(0, Ordering::Relaxed);
        runtime.last_snapshot_at.store(0, Ordering::Relaxed);
        time::sleep(config.reconnect_delay).await;
    }
}

async fn connect_control(
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
    let (ws, _) = connect_async_tls_with_config(request, None, false, connector).await?;
    runtime.connected_at.store(now_ms(), Ordering::Relaxed);
    let (mut write, mut read) = ws.split();
    loop {
        tokio::select! {
            message = read.next() => {
                let Some(message) = message else {
                    return Err(anyhow!("HTTP proxy control connection closed"));
                };
                let message = message?;
                if !message.is_text() { continue; }
                let envelope: Envelope = serde_json::from_str(message.to_text()?)?;
                if envelope.kind == "snapshot" || envelope.kind == "update" {
                    let snapshot: ProxySnapshot = serde_json::from_value(envelope.payload)?;
                    if let Some(generation) = install_snapshot(store, snapshot)? {
                        runtime.last_snapshot_generation.store(generation, Ordering::Relaxed);
                        runtime.last_snapshot_at.store(now_ms(), Ordering::Relaxed);
                        control_write_or_revoke(
                            store,
                            CONTROL_WRITE_DEADLINE,
                            write.send(Message::Text(control_ack_message(generation).into())),
                        ).await?;
                    }
                }
            }
            status = status_rx.recv() => {
                let Some(status) = status else {
                    return Err(anyhow!("HTTP proxy status producer exited"));
                };
                control_write_or_revoke(
                    store,
                    CONTROL_WRITE_DEADLINE,
                    write.send(Message::Text(status.into())),
                ).await?;
            }
        }
    }
}

fn install_snapshot(store: &Arc<SnapshotStore>, snapshot: ProxySnapshot) -> Result<Option<u64>> {
    let Some(lease) = store.store(snapshot)? else {
        return Ok(None);
    };
    Ok(Some(lease.generation))
}

async fn snapshot_lease_loop(store: Arc<SnapshotStore>) -> Result<()> {
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

fn control_ack_message(generation: u64) -> String {
    serde_json::json!({
        "ts": now_ms(),
        "kind": "ack",
        "payload": { "generation": generation }
    })
    .to_string()
}

async fn control_write_with_deadline<F>(deadline: Duration, write: F) -> Result<()>
where
    F: Future<Output = std::result::Result<(), WebSocketError>>,
{
    match time::timeout(deadline, write).await {
        Ok(result) => result.context("HTTP proxy control write failed"),
        Err(_) => Err(anyhow!("HTTP proxy control write deadline exceeded")),
    }
}

async fn control_write_or_revoke<F>(
    store: &SnapshotStore,
    deadline: Duration,
    write: F,
) -> Result<()>
where
    F: Future<Output = std::result::Result<(), WebSocketError>>,
{
    let result = control_write_with_deadline(deadline, write).await;
    if result.is_err() {
        store.clear_epoch();
    }
    result
}

async fn status_loop(
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

async fn http_listener(
    listen: String,
    store: Arc<SnapshotStore>,
    runtime: Arc<Runtime>,
    connection_slots: Arc<Semaphore>,
    tls: bool,
) -> Result<()> {
    let listener = TcpListener::bind(&listen).await?;
    info!(listen, tls, "HTTP proxy listener ready");
    let acceptor = if tls {
        let resolver = Arc::new(SnapshotCertResolver {
            store: store.clone(),
        });
        let tls_config = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_cert_resolver(resolver);
        Some(TlsAcceptor::from(Arc::new(tls_config)))
    } else {
        None
    };
    loop {
        let (stream, peer) = listener.accept().await?;
        let permit = match connection_slots.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                runtime
                    .total_rejected_requests
                    .fetch_add(1, Ordering::Relaxed);
                debug!(%peer, "HTTP proxy connection limit reached");
                drop(stream);
                continue;
            }
        };
        let store = store.clone();
        let runtime = runtime.clone();
        let acceptor = acceptor.clone();
        tokio::spawn(async move {
            let _active = ActiveConnectionGuard::new(runtime.clone(), permit);
            let result = if let Some(acceptor) = acceptor {
                match accept_tls_with_deadline(&acceptor, stream, TLS_HANDSHAKE_DEADLINE).await {
                    Ok(tls_stream) => {
                        handle_connection(tls_stream, peer, store, runtime.clone()).await
                    }
                    Err(error) => Err(anyhow!(error)),
                }
            } else {
                handle_connection(stream, peer, store, runtime.clone()).await
            };
            if let Err(error) = result {
                debug!(%peer, %error, "request handling failed");
            }
        });
    }
}

struct ActiveConnectionGuard {
    runtime: Arc<Runtime>,
    _permit: OwnedSemaphorePermit,
}

impl ActiveConnectionGuard {
    fn new(runtime: Arc<Runtime>, permit: OwnedSemaphorePermit) -> Self {
        runtime.active_connections.fetch_add(1, Ordering::Relaxed);
        Self {
            runtime,
            _permit: permit,
        }
    }
}

impl Drop for ActiveConnectionGuard {
    fn drop(&mut self) {
        self.runtime
            .active_connections
            .fetch_sub(1, Ordering::Relaxed);
    }
}

async fn accept_tls_with_deadline<S>(
    acceptor: &TlsAcceptor,
    stream: S,
    deadline: Duration,
) -> Result<tokio_rustls::server::TlsStream<S>>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    match time::timeout(deadline, acceptor.accept(stream)).await {
        Ok(result) => result.context("TLS handshake failed"),
        Err(_) => Err(anyhow!("TLS handshake deadline exceeded")),
    }
}

async fn handle_connection<S>(
    inbound: S,
    peer: SocketAddr,
    store: Arc<SnapshotStore>,
    runtime: Arc<Runtime>,
) -> Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    handle_connection_with_fixed_request_deadline(
        inbound,
        peer,
        store,
        runtime,
        REQUEST_LIFETIME_DEADLINE,
    )
    .await
}

async fn handle_connection_with_fixed_request_deadline<S>(
    mut inbound: S,
    _peer: SocketAddr,
    store: Arc<SnapshotStore>,
    runtime: Arc<Runtime>,
    fixed_request_deadline: Duration,
) -> Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    runtime.total_requests.fetch_add(1, Ordering::Relaxed);
    let head = match time::timeout(REQUEST_HEADER_DEADLINE, read_request_head(&mut inbound)).await {
        Ok(Ok(head)) => head,
        Ok(Err(error)) => return Err(error),
        Err(_) => return Err(anyhow!("request header deadline exceeded")),
    };
    let Some(header_end) = find_header_end(&head) else {
        return Err(anyhow!("request header terminator is missing"));
    };
    let plan = match request_plan(&head[..header_end]) {
        Ok(plan) => plan,
        Err(error) => {
            reject(&mut inbound, &runtime, "400 Bad Request").await?;
            return Err(error);
        }
    };
    let host = plan.host.clone();
    let mut changes = store.subscribe();
    let Some(authorization) = store.authorize_route(&host) else {
        reject(&mut inbound, &runtime, "404 Not Found").await?;
        return Ok(());
    };
    if !store.authorization_is_current(&authorization) {
        reject(&mut inbound, &runtime, "404 Not Found").await?;
        return Ok(());
    }

    let is_websocket = matches!(&plan.mode, RequestMode::WebSocket { .. });
    let proxy = proxy_request(
        &mut inbound,
        &runtime,
        &authorization.route,
        head,
        header_end,
        plan,
    );
    if is_websocket {
        // An upgraded tunnel is a connection, not a bounded HTTP request.
        // Its connect/handshake stages retain their own deadlines, while the
        // established relay remains governed by route lease/revocation and
        // peer EOF rather than the ordinary request lifetime.
        tokio::select! {
            biased;
            _ = wait_until_route_revoked(&store, &authorization, &mut changes) => {
                return Err(anyhow!("HTTP route authorization was revoked"));
            }
            result = proxy => result?,
        }
    } else {
        tokio::select! {
            biased;
            _ = wait_until_route_revoked(&store, &authorization, &mut changes) => {
                return Err(anyhow!("HTTP route authorization was revoked"));
            }
            result = time::timeout(fixed_request_deadline, proxy) => {
                match result {
                    Ok(result) => result?,
                    Err(_) => return Err(anyhow!("request lifetime deadline exceeded")),
                }
            }
        }
    }
    debug!(binding_id = %authorization.route.binding_id, hostname = %host, "proxied request");
    Ok(())
}

async fn read_request_head<S: AsyncRead + Unpin>(inbound: &mut S) -> Result<Vec<u8>> {
    let mut head = Vec::with_capacity(4096);
    let mut buf = [0_u8; 1024];
    loop {
        let n = inbound.read(&mut buf).await?;
        if n == 0 {
            return Ok(head);
        }
        head.extend_from_slice(&buf[..n]);
        if let Some(header_end) = find_header_end(&head) {
            if header_end > MAX_REQUEST_HEADER_BYTES {
                return Err(anyhow!("request header is too large"));
            }
            return Ok(head);
        }
        if head.len() > MAX_REQUEST_HEADER_BYTES {
            return Err(anyhow!("request header is too large"));
        }
    }
}

fn find_header_end(bytes: &[u8]) -> Option<usize> {
    bytes
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|offset| offset + 4)
}

struct RequestPlan {
    host: String,
    header: Vec<u8>,
    mode: RequestMode,
}

enum RequestMode {
    FixedBody { body_len: usize },
    WebSocket { expected_accept: String },
}

fn request_plan(header: &[u8]) -> Result<RequestPlan> {
    let text = std::str::from_utf8(header).context("request header is not UTF-8")?;
    let mut lines = text.split("\r\n");
    let request_line = lines
        .next()
        .filter(|line| !line.is_empty())
        .context("missing request line")?;
    let request_parts = request_line.split_whitespace().collect::<Vec<_>>();
    if request_parts.len() != 3
        || !is_http_token(request_parts[0])
        || !(request_parts[1].starts_with('/') || request_parts[1] == "*")
        || !matches!(request_parts[2], "HTTP/1.0" | "HTTP/1.1")
    {
        return Err(anyhow!("malformed or unsupported HTTP request line"));
    }
    if request_parts[0].eq_ignore_ascii_case("CONNECT") {
        return Err(anyhow!("CONNECT tunneling is disabled"));
    }
    let mut content_length = None;
    let mut host_count = 0;
    let mut host = None;
    let mut connection = None;
    let mut upgrade = None;
    let mut websocket_key = None;
    let mut websocket_version = None;
    let mut websocket_protocol_seen = false;
    let mut websocket_extensions_seen = false;
    let mut websocket_header_seen = false;
    let mut rewritten = format!("{request_line}\r\n");
    for line in lines {
        if line.is_empty() {
            break;
        }
        let (name, value) = line.split_once(':').context("malformed request header")?;
        if !is_http_token(name) {
            return Err(anyhow!("malformed request header name"));
        }
        if invalid_header_value(value) {
            return Err(anyhow!("malformed request header value"));
        }
        if name.eq_ignore_ascii_case("host") {
            host_count += 1;
            host = Some(normalize_host_authority(value)?);
        }
        if name.eq_ignore_ascii_case("transfer-encoding") || name.eq_ignore_ascii_case("expect") {
            return Err(anyhow!("streaming request bodies are disabled"));
        }
        if name.eq_ignore_ascii_case("content-length") {
            if content_length.is_some() {
                return Err(anyhow!("duplicate Content-Length header"));
            }
            let value = value.trim();
            if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err(anyhow!("invalid Content-Length"));
            }
            let parsed = value.parse::<usize>().context("invalid Content-Length")?;
            if parsed > MAX_REQUEST_BODY_BYTES {
                return Err(anyhow!("request body is too large"));
            }
            content_length = Some(parsed);
        }
        if name.eq_ignore_ascii_case("connection") {
            if connection.replace(value.trim().to_string()).is_some() {
                return Err(anyhow!("duplicate Connection header"));
            }
            continue;
        }
        if name.eq_ignore_ascii_case("upgrade") {
            if upgrade.replace(value.trim().to_string()).is_some() {
                return Err(anyhow!("duplicate Upgrade header"));
            }
            websocket_header_seen = true;
            continue;
        }
        if name.eq_ignore_ascii_case("sec-websocket-key") {
            if websocket_key.replace(value.trim().to_string()).is_some() {
                return Err(anyhow!("duplicate Sec-WebSocket-Key header"));
            }
            websocket_header_seen = true;
        }
        if name.eq_ignore_ascii_case("sec-websocket-version") {
            if websocket_version
                .replace(value.trim().to_string())
                .is_some()
            {
                return Err(anyhow!("duplicate Sec-WebSocket-Version header"));
            }
            websocket_header_seen = true;
        }
        if name.eq_ignore_ascii_case("sec-websocket-protocol") {
            if websocket_protocol_seen {
                return Err(anyhow!("duplicate Sec-WebSocket-Protocol header"));
            }
            websocket_protocol_seen = true;
            websocket_header_seen = true;
        }
        if name.eq_ignore_ascii_case("sec-websocket-extensions") {
            if websocket_extensions_seen {
                return Err(anyhow!("duplicate Sec-WebSocket-Extensions header"));
            }
            websocket_extensions_seen = true;
            websocket_header_seen = true;
        }
        if name.eq_ignore_ascii_case("sec-websocket-accept") {
            return Err(anyhow!(
                "Sec-WebSocket-Accept is forbidden in a client request"
            ));
        }
        if name.eq_ignore_ascii_case("proxy-connection") || name.eq_ignore_ascii_case("keep-alive")
        {
            continue;
        }
        rewritten.push_str(line);
        rewritten.push_str("\r\n");
    }
    if host_count != 1 {
        return Err(anyhow!("exactly one Host header is required"));
    }
    let connection_has_upgrade = match connection.as_deref() {
        Some(value) => header_has_token(value, "upgrade")?,
        None => false,
    };
    let websocket_intent = websocket_header_seen || upgrade.is_some() || connection_has_upgrade;
    let mode = if websocket_intent {
        if request_parts[0] != "GET"
            || request_parts[2] != "HTTP/1.1"
            || !request_parts[1].starts_with('/')
        {
            return Err(anyhow!("WebSocket upgrade requires GET over HTTP/1.1"));
        }
        if content_length.is_some() {
            return Err(anyhow!("WebSocket upgrade must not include Content-Length"));
        }
        if !connection_has_upgrade {
            return Err(anyhow!("WebSocket Connection token is missing"));
        }
        if upgrade
            .as_deref()
            .is_none_or(|value| !value.eq_ignore_ascii_case("websocket"))
        {
            return Err(anyhow!("only a WebSocket Upgrade is supported"));
        }
        if websocket_version.as_deref() != Some("13") {
            return Err(anyhow!("only WebSocket version 13 is supported"));
        }
        let key = websocket_key.context("Sec-WebSocket-Key is required")?;
        let decoded = BASE64_STANDARD
            .decode(key.as_bytes())
            .map_err(|_| anyhow!("Sec-WebSocket-Key is invalid"))?;
        if decoded.len() != 16 {
            return Err(anyhow!("Sec-WebSocket-Key is invalid"));
        }
        rewritten.push_str("Upgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
        RequestMode::WebSocket {
            expected_accept: tokio_tungstenite::tungstenite::handshake::derive_accept_key(
                key.as_bytes(),
            ),
        }
    } else {
        rewritten.push_str("Connection: close\r\n\r\n");
        RequestMode::FixedBody {
            body_len: content_length.unwrap_or(0),
        }
    };
    Ok(RequestPlan {
        host: host.context("Host header is empty or invalid")?,
        header: rewritten.into_bytes(),
        mode,
    })
}

async fn proxy_request<S: AsyncRead + AsyncWrite + Unpin>(
    inbound: &mut S,
    runtime: &Runtime,
    route: &Route,
    received: Vec<u8>,
    header_end: usize,
    plan: RequestPlan,
) -> Result<()> {
    match plan.mode {
        RequestMode::FixedBody { body_len } => {
            proxy_single_request(
                inbound,
                runtime,
                route,
                received,
                header_end,
                plan.header,
                body_len,
            )
            .await
        }
        RequestMode::WebSocket { expected_accept } => {
            if received.len() != header_end {
                reject(inbound, runtime, "400 Bad Request").await?;
                return Err(anyhow!(
                    "early WebSocket data or a pipelined request is forbidden"
                ));
            }
            proxy_websocket_upgrade(
                inbound,
                runtime,
                route,
                plan.header,
                &expected_accept,
                UPSTREAM_UPGRADE_HEADER_DEADLINE,
            )
            .await
        }
    }
}

async fn proxy_single_request<S: AsyncRead + AsyncWrite + Unpin>(
    inbound: &mut S,
    runtime: &Runtime,
    route: &Route,
    received: Vec<u8>,
    header_end: usize,
    header: Vec<u8>,
    body_len: usize,
) -> Result<()> {
    let mut body = received[header_end..].to_vec();
    if !initial_body_bytes_allowed(body_len, body.len()) {
        reject(inbound, runtime, "400 Bad Request").await?;
        return Err(anyhow!(
            "pipelined or cross-host follow-up request is forbidden"
        ));
    }
    body.resize(body_len, 0);
    if body_len > received.len().saturating_sub(header_end) {
        inbound
            .read_exact(&mut body[received.len().saturating_sub(header_end)..])
            .await?;
    }

    let mut upstream = connect_upstream(inbound, runtime, route).await?;
    upstream.write_all(&header).await?;
    upstream.write_all(&body).await?;
    upstream.shutdown().await?;
    io::copy(&mut upstream, inbound).await?;
    inbound.shutdown().await?;
    Ok(())
}

async fn connect_upstream<S: AsyncWrite + Unpin>(
    inbound: &mut S,
    runtime: &Runtime,
    route: &Route,
) -> Result<TcpStream> {
    let upstream_addr = format!("{}:{}", route.target_ip, route.target_port);
    match time::timeout(
        UPSTREAM_CONNECT_DEADLINE,
        TcpStream::connect(&upstream_addr),
    )
    .await
    {
        Ok(Ok(stream)) => Ok(stream),
        Ok(Err(error)) => {
            reject(inbound, runtime, "503 Service Unavailable").await?;
            Err(error.into())
        }
        Err(_) => {
            reject(inbound, runtime, "503 Service Unavailable").await?;
            Err(anyhow!("upstream connection deadline exceeded"))
        }
    }
}

async fn proxy_websocket_upgrade<S: AsyncRead + AsyncWrite + Unpin>(
    inbound: &mut S,
    runtime: &Runtime,
    route: &Route,
    header: Vec<u8>,
    expected_accept: &str,
    response_deadline: Duration,
) -> Result<()> {
    let mut upstream = connect_upstream(inbound, runtime, route).await?;
    upstream.write_all(&header).await?;
    let response = match time::timeout(response_deadline, read_response_head(&mut upstream)).await {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => {
            reject(inbound, runtime, "502 Bad Gateway").await?;
            return Err(error);
        }
        Err(_) => {
            reject(inbound, runtime, "504 Gateway Timeout").await?;
            return Err(anyhow!("upstream WebSocket response deadline exceeded"));
        }
    };
    let Some(response_header_end) = find_header_end(&response) else {
        reject(inbound, runtime, "502 Bad Gateway").await?;
        return Err(anyhow!("upstream WebSocket response is incomplete"));
    };
    if let Err(error) =
        validate_websocket_response(&response[..response_header_end], expected_accept)
    {
        reject(inbound, runtime, "502 Bad Gateway").await?;
        return Err(error);
    }
    inbound.write_all(&response).await?;
    let _ = io::copy_bidirectional(inbound, &mut upstream).await?;
    inbound.shutdown().await?;
    upstream.shutdown().await?;
    Ok(())
}

async fn read_response_head<S: AsyncRead + Unpin>(upstream: &mut S) -> Result<Vec<u8>> {
    let mut head = Vec::with_capacity(1024);
    let mut buf = [0_u8; 1024];
    loop {
        let n = upstream.read(&mut buf).await?;
        if n == 0 {
            return Ok(head);
        }
        head.extend_from_slice(&buf[..n]);
        if let Some(header_end) = find_header_end(&head) {
            if header_end > MAX_UPSTREAM_UPGRADE_HEADER_BYTES {
                return Err(anyhow!("upstream WebSocket response header is too large"));
            }
            return Ok(head);
        }
        if head.len() > MAX_UPSTREAM_UPGRADE_HEADER_BYTES {
            return Err(anyhow!("upstream WebSocket response header is too large"));
        }
    }
}

fn validate_websocket_response(header: &[u8], expected_accept: &str) -> Result<()> {
    let text = std::str::from_utf8(header).context("upstream WebSocket response is not UTF-8")?;
    let mut lines = text.split("\r\n");
    let status = lines.next().context("missing upstream response status")?;
    let mut status_parts = status.splitn(3, ' ');
    if status_parts.next() != Some("HTTP/1.1") || status_parts.next() != Some("101") {
        return Err(anyhow!("upstream did not accept the WebSocket upgrade"));
    }
    let mut connection = None;
    let mut upgrade = None;
    let mut accept = None;
    for line in lines {
        if line.is_empty() {
            break;
        }
        let (name, value) = line
            .split_once(':')
            .context("malformed upstream WebSocket response header")?;
        if !is_http_token(name) || invalid_header_value(value) {
            return Err(anyhow!("malformed upstream WebSocket response header"));
        }
        if name.eq_ignore_ascii_case("content-length")
            || name.eq_ignore_ascii_case("transfer-encoding")
        {
            return Err(anyhow!(
                "upstream WebSocket response contains a forbidden body framing header"
            ));
        }
        if name.eq_ignore_ascii_case("connection")
            && connection.replace(value.trim().to_string()).is_some()
        {
            return Err(anyhow!("duplicate upstream Connection header"));
        }
        if name.eq_ignore_ascii_case("upgrade")
            && upgrade.replace(value.trim().to_string()).is_some()
        {
            return Err(anyhow!("duplicate upstream Upgrade header"));
        }
        if name.eq_ignore_ascii_case("sec-websocket-accept")
            && accept.replace(value.trim().to_string()).is_some()
        {
            return Err(anyhow!("duplicate upstream Sec-WebSocket-Accept header"));
        }
    }
    if !header_has_token(
        connection
            .as_deref()
            .context("upstream Connection header is missing")?,
        "upgrade",
    )? {
        return Err(anyhow!("upstream Connection upgrade token is missing"));
    }
    if upgrade
        .as_deref()
        .is_none_or(|value| !value.eq_ignore_ascii_case("websocket"))
    {
        return Err(anyhow!("upstream Upgrade header is not websocket"));
    }
    if accept.as_deref() != Some(expected_accept) {
        return Err(anyhow!("upstream Sec-WebSocket-Accept is invalid"));
    }
    Ok(())
}

fn header_has_token(value: &str, expected: &str) -> Result<bool> {
    let mut found = false;
    for token in value.split(',') {
        let token = token.trim();
        if !is_http_token(token) {
            return Err(anyhow!("malformed comma-separated header token"));
        }
        found |= token.eq_ignore_ascii_case(expected);
    }
    Ok(found)
}

fn invalid_header_value(value: &str) -> bool {
    value
        .bytes()
        .any(|byte| (byte < b' ' && byte != b'\t') || byte == 0x7f)
}

fn initial_body_bytes_allowed(content_length: usize, received_after_header: usize) -> bool {
    received_after_header <= content_length
}

fn is_http_token(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(
                    byte,
                    b'!' | b'#'
                        | b'$'
                        | b'%'
                        | b'&'
                        | b'\''
                        | b'*'
                        | b'+'
                        | b'-'
                        | b'.'
                        | b'^'
                        | b'_'
                        | b'`'
                        | b'|'
                        | b'~'
                )
        })
}

fn normalize_host_authority(value: &str) -> Result<String> {
    let authority = value.trim();
    if authority.is_empty()
        || !authority.is_ascii()
        || authority
            .bytes()
            .any(|byte| byte.is_ascii_whitespace() || matches!(byte, b'/' | b'\\' | b'@'))
    {
        return Err(anyhow!("invalid Host authority"));
    }
    let mut parts = authority.split(':');
    let hostname = parts.next().unwrap_or("").trim_end_matches('.');
    if let Some(port) = parts.next() {
        if parts.next().is_some()
            || port.is_empty()
            || !port.bytes().all(|byte| byte.is_ascii_digit())
            || port.parse::<u16>().ok().filter(|port| *port > 0).is_none()
        {
            return Err(anyhow!("invalid Host port"));
        }
    }
    if hostname.is_empty()
        || hostname.starts_with('.')
        || hostname.contains("..")
        || !hostname
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
    {
        return Err(anyhow!("invalid Host name"));
    }
    Ok(hostname.to_ascii_lowercase())
}

async fn wait_until_route_revoked(
    store: &SnapshotStore,
    authorization: &RouteAuthorization,
    changes: &mut watch::Receiver<u64>,
) {
    loop {
        let Some(deadline) = store.authorization_deadline(authorization) else {
            return;
        };
        tokio::select! {
            biased;
            _ = time::sleep_until(time::Instant::from_std(deadline)) => {
                if store.authorization_deadline(authorization).is_none() {
                    return;
                }
            }
            changed = changes.changed() => {
                if changed.is_err() {
                    return;
                }
            }
        }
    }
}

async fn reject<S: AsyncWrite + Unpin>(
    inbound: &mut S,
    runtime: &Runtime,
    status: &str,
) -> Result<()> {
    runtime
        .total_rejected_requests
        .fetch_add(1, Ordering::Relaxed);
    inbound
        .write_all(
            format!("HTTP/1.1 {status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
                .as_bytes(),
        )
        .await?;
    inbound.shutdown().await?;
    Ok(())
}

fn hostname_matches_wildcard(hostname: &str, wildcard: &str) -> bool {
    let wildcard = wildcard.trim_end_matches('.').to_ascii_lowercase();
    let suffix = wildcard.strip_prefix('*').unwrap_or(&wildcard);
    if !hostname.ends_with(suffix) {
        return false;
    }
    let prefix = &hostname[..hostname.len() - suffix.len()];
    !prefix.is_empty() && !prefix.contains('.')
}

fn is_valid_wildcard_domain(value: &str) -> bool {
    let Some(suffix) = value.strip_prefix("*.") else {
        return false;
    };
    !suffix.is_empty()
        && suffix.len() <= 253
        && suffix.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
}

fn required_control_token(name: &str, file_name: &str) -> Result<String> {
    load_control_token(
        name,
        std::env::var_os(name),
        file_name,
        std::env::var_os(file_name).map(PathBuf::from),
    )
}

fn load_control_token(
    name: &str,
    direct: Option<OsString>,
    file_name: &str,
    file: Option<PathBuf>,
) -> Result<String> {
    match (direct, file) {
        (Some(_), Some(_)) => Err(anyhow!("{name} and {file_name} are mutually exclusive")),
        (Some(token), None) => {
            let token = token
                .into_string()
                .map_err(|_| anyhow!("{name} must be valid UTF-8"))?;
            validate_control_token(name, &token)?;
            Ok(token)
        }
        (None, Some(path)) => read_control_token_file(name, file_name, &path),
        (None, None) => Err(anyhow!("{name} or {file_name} is required")),
    }
}

fn read_control_token_file(name: &str, file_name: &str, path: &Path) -> Result<String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    let file = options
        .open(path)
        .with_context(|| format!("failed to open {file_name}"))?;
    let metadata = file
        .metadata()
        .with_context(|| format!("failed to inspect {file_name}"))?;
    if !metadata.is_file() {
        return Err(anyhow!("{file_name} must reference a regular file"));
    }
    #[cfg(unix)]
    {
        let mode = metadata.permissions().mode() & 0o777;
        if mode & 0o400 == 0 || mode & 0o077 != 0 || mode & 0o111 != 0 {
            return Err(anyhow!(
                "{file_name} must be owner-readable, non-executable, and inaccessible to group/other"
            ));
        }
    }
    if metadata.len() > MAX_CONTROL_TOKEN_BYTES as u64 {
        return Err(anyhow!(
            "{file_name} content is outside the allowed token size"
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_CONTROL_TOKEN_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .with_context(|| format!("failed to read {file_name}"))?;
    if bytes.len() > MAX_CONTROL_TOKEN_BYTES {
        return Err(anyhow!(
            "{file_name} content is outside the allowed token size"
        ));
    }
    let token =
        String::from_utf8(bytes).map_err(|_| anyhow!("{file_name} content must be valid UTF-8"))?;
    validate_control_token(name, &token)?;
    Ok(token)
}

fn validate_backend_ws_url(value: &str, has_custom_ca: bool) -> Result<()> {
    let request = value
        .into_client_request()
        .context("NYABASE_BACKEND_WS is not a valid WebSocket URL")?;
    match request.uri().scheme_str() {
        Some("wss") => Ok(()),
        Some("ws") if !has_custom_ca => Ok(()),
        Some("ws") => Err(anyhow!(
            "NYABASE_BACKEND_CA_FILE requires a wss:// Backend URL"
        )),
        _ => Err(anyhow!("NYABASE_BACKEND_WS must use ws:// or wss://")),
    }
}

fn backend_tls_config_from_env(name: &str) -> Result<Option<Arc<rustls::ClientConfig>>> {
    let Some(path) = std::env::var_os(name).map(PathBuf::from) else {
        return Ok(None);
    };
    if path.as_os_str().is_empty() {
        return Err(anyhow!("{name} must not be empty when configured"));
    }
    let pem = read_bounded_ca_file(name, &path)?;
    Ok(Some(backend_tls_config_from_pem(name, &pem)?))
}

fn read_bounded_ca_file(name: &str, path: &Path) -> Result<Vec<u8>> {
    let file = OpenOptions::new()
        .read(true)
        .open(path)
        .with_context(|| format!("failed to open {name}"))?;
    let metadata = file
        .metadata()
        .with_context(|| format!("failed to inspect {name}"))?;
    if !metadata.is_file() {
        return Err(anyhow!("{name} must reference a regular file"));
    }
    if metadata.len() == 0 || metadata.len() > MAX_BACKEND_CA_PEM_BYTES {
        return Err(anyhow!(
            "{name} must contain a non-empty bounded PEM bundle"
        ));
    }
    let mut pem = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_BACKEND_CA_PEM_BYTES + 1)
        .read_to_end(&mut pem)
        .with_context(|| format!("failed to read {name}"))?;
    if pem.is_empty() || pem.len() as u64 > MAX_BACKEND_CA_PEM_BYTES {
        return Err(anyhow!(
            "{name} must contain a non-empty bounded PEM bundle"
        ));
    }
    Ok(pem)
}

fn backend_tls_config_from_pem(name: &str, pem: &[u8]) -> Result<Arc<rustls::ClientConfig>> {
    if pem.is_empty() {
        return Err(anyhow!("{name} contains no CA certificates"));
    }
    let mut reader = BufReader::new(pem);
    let mut roots = rustls::RootCertStore::empty();
    let mut certificates = 0usize;
    for item in rustls_pemfile::read_all(&mut reader) {
        let item = item.map_err(|_| anyhow!("{name} contains invalid PEM"))?;
        let rustls_pemfile::Item::X509Certificate(certificate) = item else {
            return Err(anyhow!("{name} may contain only CA certificates"));
        };
        roots
            .add(certificate)
            .map_err(|_| anyhow!("{name} contains an invalid CA certificate"))?;
        certificates += 1;
    }
    if certificates == 0 {
        return Err(anyhow!("{name} contains no CA certificates"));
    }
    Ok(Arc::new(
        rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .context("failed to select secure Backend TLS protocol versions")?
        .with_root_certificates(roots)
        .with_no_client_auth(),
    ))
}

fn validate_control_token(name: &str, token: &str) -> Result<()> {
    if !(MIN_CONTROL_TOKEN_BYTES..=MAX_CONTROL_TOKEN_BYTES).contains(&token.len()) {
        return Err(anyhow!(
            "{name} must be {MIN_CONTROL_TOKEN_BYTES}..={MAX_CONTROL_TOKEN_BYTES} bytes"
        ));
    }
    if !token
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err(anyhow!(
            "{name} must use only ASCII letters, digits, '_' or '-'"
        ));
    }
    Ok(())
}

fn validate_status_interval(value: u64) -> Result<Duration> {
    if !(MIN_STATUS_INTERVAL_MS..=MAX_STATUS_INTERVAL_MS).contains(&value) {
        return Err(anyhow!(
            "NYABASE_HTTP_STATUS_INTERVAL_MS must be in {MIN_STATUS_INTERVAL_MS}..={MAX_STATUS_INTERVAL_MS}"
        ));
    }
    Ok(Duration::from_millis(value))
}

fn validate_connection_cap(value: usize) -> Result<usize> {
    if !(1..=MAX_ACTIVE_CONNECTIONS).contains(&value) {
        return Err(anyhow!(
            "NYABASE_HTTP_MAX_CONNECTIONS must be in 1..={MAX_ACTIVE_CONNECTIONS}"
        ));
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

fn absolute_snapshot_remaining(
    valid_until_ms: u64,
    stale_after_ms: u64,
    wall_now_ms: u64,
) -> Result<Duration> {
    let latest_allowed = wall_now_ms
        .checked_add(stale_after_ms)
        .and_then(|value| value.checked_add(MAX_SNAPSHOT_CLOCK_SKEW_MS))
        .context("HTTP proxy snapshot absolute lease overflow")?;
    if valid_until_ms > latest_allowed {
        return Err(anyhow!(
            "HTTP proxy snapshot validUntil is too far in the future"
        ));
    }
    let remaining_ms = valid_until_ms
        .checked_sub(wall_now_ms)
        .filter(|remaining| *remaining > 0)
        .context("HTTP proxy snapshot absolute lease already expired")?;
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
    use std::io::Write as _;
    use std::sync::atomic::AtomicU64;

    static NEXT_TEST_FILE: AtomicU64 = AtomicU64::new(1);

    struct PrivateTestFile {
        path: PathBuf,
    }

    impl PrivateTestFile {
        fn new(contents: &[u8], mode: u32) -> Self {
            let id = NEXT_TEST_FILE.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "nyabase-http-proxy-secret-{}-{id}",
                std::process::id()
            ));
            let mut file = std::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&path)
                .unwrap();
            file.write_all(contents).unwrap();
            file.sync_all().unwrap();
            #[cfg(unix)]
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
            Self { path }
        }
    }

    impl Drop for PrivateTestFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.path);
        }
    }

    #[test]
    fn control_token_is_required_to_be_trim_exact_and_bounded() {
        assert!(validate_control_token("HTTP_PROXY_TOKEN", &"a".repeat(32)).is_ok());
        assert!(validate_control_token("HTTP_PROXY_TOKEN", &"a".repeat(1024)).is_ok());
        assert!(validate_control_token("HTTP_PROXY_TOKEN", &"a".repeat(31)).is_err());
        assert!(validate_control_token("HTTP_PROXY_TOKEN", &"a".repeat(1025)).is_err());
        assert!(
            validate_control_token("HTTP_PROXY_TOKEN", &format!(" {}", "a".repeat(32))).is_err()
        );
        assert!(
            validate_control_token("HTTP_PROXY_TOKEN", &format!("{}\n", "a".repeat(32))).is_err()
        );
        assert!(validate_control_token(
            "HTTP_PROXY_TOKEN",
            &format!("{}\n{}", "a".repeat(16), "a".repeat(16)),
        )
        .is_err());
        assert!(validate_control_token(
            "HTTP_PROXY_TOKEN",
            &format!("{} internal", "a".repeat(32)),
        )
        .is_err());
        assert!(
            validate_control_token("HTTP_PROXY_TOKEN", &format!("é{}", "a".repeat(32))).is_err()
        );
    }

    #[test]
    fn control_token_file_is_mutually_exclusive_private_and_non_leaking() {
        let token = "a".repeat(32);
        let private = PrivateTestFile::new(token.as_bytes(), 0o600);
        assert_eq!(
            load_control_token(
                "HTTP_PROXY_TOKEN",
                None,
                "HTTP_PROXY_TOKEN_FILE",
                Some(private.path.clone()),
            )
            .unwrap(),
            token,
        );
        assert!(load_control_token(
            "HTTP_PROXY_TOKEN",
            Some(OsString::from("b".repeat(32))),
            "HTTP_PROXY_TOKEN_FILE",
            Some(private.path.clone()),
        )
        .unwrap_err()
        .to_string()
        .contains("mutually exclusive"));

        let public = PrivateTestFile::new(token.as_bytes(), 0o644);
        assert!(load_control_token(
            "HTTP_PROXY_TOKEN",
            None,
            "HTTP_PROXY_TOKEN_FILE",
            Some(public.path.clone()),
        )
        .is_err());

        let invalid_secret = format!("{}!", "s".repeat(31));
        let invalid = PrivateTestFile::new(invalid_secret.as_bytes(), 0o400);
        let error = load_control_token(
            "HTTP_PROXY_TOKEN",
            None,
            "HTTP_PROXY_TOKEN_FILE",
            Some(invalid.path.clone()),
        )
        .unwrap_err()
        .to_string();
        assert!(!error.contains(&invalid_secret));

        let newline = PrivateTestFile::new(format!("{token}\n").as_bytes(), 0o400);
        assert!(load_control_token(
            "HTTP_PROXY_TOKEN",
            None,
            "HTTP_PROXY_TOKEN_FILE",
            Some(newline.path.clone()),
        )
        .is_err());
        let empty = PrivateTestFile::new(b"", 0o400);
        assert!(load_control_token(
            "HTTP_PROXY_TOKEN",
            None,
            "HTTP_PROXY_TOKEN_FILE",
            Some(empty.path.clone()),
        )
        .is_err());
        let oversized = PrivateTestFile::new("a".repeat(1025).as_bytes(), 0o400);
        assert!(load_control_token(
            "HTTP_PROXY_TOKEN",
            None,
            "HTTP_PROXY_TOKEN_FILE",
            Some(oversized.path.clone()),
        )
        .is_err());
    }

    #[test]
    fn backend_ca_is_explicit_and_plain_ws_remains_compatible_without_it() {
        assert!(validate_backend_ws_url("wss://backend.example/ws/http-proxy", false).is_ok());
        assert!(validate_backend_ws_url("wss://backend.example/ws/http-proxy", true).is_ok());
        assert!(validate_backend_ws_url("ws://backend.example/ws/http-proxy", false).is_ok());
        assert!(validate_backend_ws_url("ws://backend.example/ws/http-proxy", true).is_err());
        assert!(validate_backend_ws_url("http://backend.example/ws/http-proxy", false).is_err());
        assert!(backend_tls_config_from_pem(
            "NYABASE_BACKEND_CA_FILE",
            include_bytes!("../tests/fixtures/test-ca.pem"),
        )
        .is_ok());
        assert!(backend_tls_config_from_pem("NYABASE_BACKEND_CA_FILE", b"").is_err());
        assert!(
            backend_tls_config_from_pem("NYABASE_BACKEND_CA_FILE", b"not a PEM bundle").is_err()
        );
        assert!(backend_tls_config_from_pem(
            "NYABASE_BACKEND_CA_FILE",
            b"-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----\n",
        )
        .is_err());
    }

    #[test]
    fn http_connection_cap_and_status_interval_are_hard_bounded() {
        assert_eq!(validate_connection_cap(1).unwrap(), 1);
        assert_eq!(
            validate_connection_cap(MAX_ACTIVE_CONNECTIONS).unwrap(),
            MAX_ACTIVE_CONNECTIONS
        );
        assert!(validate_connection_cap(0).is_err());
        assert!(validate_connection_cap(MAX_ACTIVE_CONNECTIONS + 1).is_err());
        assert_eq!(
            validate_status_interval(MIN_STATUS_INTERVAL_MS).unwrap(),
            Duration::from_millis(MIN_STATUS_INTERVAL_MS)
        );
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
    fn parses_and_normalizes_exactly_one_host_header() {
        let head = b"GET / HTTP/1.1\r\nHost: App.Example.test:8080\r\n\r\n";
        assert_eq!(request_plan(head).unwrap().host, "app.example.test");
        assert!(request_plan(
            b"GET / HTTP/1.1\r\nHost: one.example.test\r\nHost: two.example.test\r\n\r\n"
        )
        .is_err());
    }

    #[test]
    fn matches_single_label_wildcard() {
        assert!(hostname_matches_wildcard(
            "app.example.test",
            "*.example.test"
        ));
        assert!(!hostname_matches_wildcard(
            "deep.app.example.test",
            "*.example.test"
        ));
    }

    #[test]
    fn rejects_snapshot_rollback_within_one_connection_epoch() {
        let store = SnapshotStore::default();
        let snapshot = |generation| ProxySnapshot {
            generation,
            stale_after_ms: 30_000,
            valid_until_ms: now_ms() + 30_000,
            routes: Vec::new(),
            domain_pools: Vec::new(),
        };

        assert!(store.store(snapshot(2)).unwrap().is_some());
        assert!(store.store(snapshot(1)).unwrap().is_none());
        assert!(store.store(snapshot(2)).unwrap().is_none());
        assert_eq!(store.load().unwrap().generation, 2);

        store.clear_epoch();
        assert!(store.store(snapshot(1)).unwrap().is_some());
        assert_eq!(store.load().unwrap().generation, 1);
    }

    #[test]
    fn snapshot_lease_is_required_and_bounded() {
        assert!(serde_json::from_value::<ProxySnapshot>(serde_json::json!({
            "generation": 1,
            "routes": [],
            "domainPools": []
        }))
        .is_err());

        let store = SnapshotStore::default();
        assert!(store
            .store(ProxySnapshot {
                generation: 1,
                stale_after_ms: MAX_SNAPSHOT_STALE_AFTER_MS + 1,
                valid_until_ms: now_ms() + MAX_SNAPSHOT_STALE_AFTER_MS + 1,
                routes: Vec::new(),
                domain_pools: Vec::new(),
            })
            .is_err());
    }

    #[test]
    fn one_invalid_tls_pool_rejects_the_whole_snapshot_without_partial_install() {
        let store = SnapshotStore::default();
        store
            .store(test_snapshot(1, 30_000, vec![test_route(8080)]))
            .unwrap();
        let mut invalid = test_snapshot(2, 30_000, vec![test_route(8081)]);
        invalid.domain_pools = vec![DomainPool {
            wildcard_domain: "*.example.test".to_string(),
            certificate_pem: None,
            private_key_pem: Some("not-a-key".to_string()),
        }];

        assert!(store.store(invalid).is_err());
        assert_eq!(store.load().map(|snapshot| snapshot.generation), Some(1));
    }

    #[test]
    fn control_ack_is_a_complete_protocol_envelope() {
        let ack: serde_json::Value = serde_json::from_str(&control_ack_message(7)).unwrap();
        assert!(ack["ts"].as_u64().is_some());
        assert_eq!(ack["kind"], "ack");
        assert_eq!(ack["payload"]["generation"], 7);
    }

    #[tokio::test]
    async fn expires_without_an_update_and_keeps_the_generation_fence() {
        let route = test_route(9);
        let store = Arc::new(SnapshotStore::default());
        assert_eq!(
            install_snapshot(&store, test_snapshot(1, 20, vec![route.clone()])).unwrap(),
            Some(1)
        );

        time::sleep(Duration::from_millis(50)).await;

        assert!(store.load().is_none());
        assert!(!store.route_is_current(&route));
        assert!(store
            .store(test_snapshot(1, 20, vec![route]))
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn request_side_deadline_revokes_even_without_the_global_expiry_task() {
        let route = test_route(9);
        let store = SnapshotStore::default();
        store
            .store(test_snapshot(1, 20, vec![route.clone()]))
            .unwrap();
        let authorization = store.authorize_route(&route.hostname).unwrap();
        let mut changes = store.subscribe();

        time::timeout(
            Duration::from_millis(200),
            wait_until_route_revoked(&store, &authorization, &mut changes),
        )
        .await
        .expect("request-side lease deadline did not revoke authorization");

        assert!(!store.authorization_is_current(&authorization));
    }

    #[tokio::test]
    async fn a_periodic_renewal_extends_service_past_the_previous_deadline() {
        let route = test_route(9);
        let store = Arc::new(SnapshotStore::default());
        assert_eq!(
            install_snapshot(&store, test_snapshot(1, 120, vec![route.clone()])).unwrap(),
            Some(1)
        );
        let authorization = store.authorize_route(&route.hostname).unwrap();
        let mut changes = store.subscribe();
        let request_store = store.clone();
        let request_lease = tokio::spawn(async move {
            wait_until_route_revoked(&request_store, &authorization, &mut changes).await;
        });
        time::sleep(Duration::from_millis(40)).await;
        assert_eq!(
            install_snapshot(&store, test_snapshot(2, 120, vec![route.clone()])).unwrap(),
            Some(2)
        );

        time::sleep(Duration::from_millis(90)).await;
        assert_eq!(store.load().map(|snapshot| snapshot.generation), Some(2));
        assert!(store.route_is_current(&route));
        assert!(!request_lease.is_finished());

        time::sleep(Duration::from_millis(50)).await;
        assert!(store.load().is_none());
        time::timeout(Duration::from_millis(200), request_lease)
            .await
            .expect("renewed request did not stop at the new deadline")
            .unwrap();
    }

    #[test]
    fn forces_one_fixed_body_request_per_connection() {
        let plan = request_plan(b"POST / HTTP/1.1\r\nHost: app.example.test\r\nContent-Length: 4\r\nConnection: keep-alive\r\n\r\n").unwrap();
        assert!(matches!(plan.mode, RequestMode::FixedBody { body_len: 4 }));
        assert!(String::from_utf8(plan.header)
            .unwrap()
            .contains("Connection: close\r\n"));
        assert!(initial_body_bytes_allowed(4, 4));
        assert!(!initial_body_bytes_allowed(4, 5));
        assert!(request_plan(
            b"POST / HTTP/1.1\r\nHost: app.example.test\r\nContent-Length: 4\r\nContent-Length: 4\r\n\r\n"
        )
        .is_err());
        assert!(request_plan(
            b"GET http://attacker.invalid/ HTTP/1.1\r\nHost: app.example.test\r\n\r\n"
        )
        .is_err());
    }

    #[test]
    fn accepts_only_bounded_unambiguous_rfc6455_upgrades() {
        let valid = b"GET /socket HTTP/1.1\r\nHost: app.example.test\r\nConnection: keep-alive, Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n";
        let plan = request_plan(valid).unwrap();
        assert!(matches!(plan.mode, RequestMode::WebSocket { .. }));
        let rewritten = String::from_utf8(plan.header).unwrap();
        assert!(rewritten.contains("Upgrade: websocket\r\nConnection: Upgrade\r\n"));

        for invalid in [
            b"GET / HTTP/1.1\r\nHost: app.example.test\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n".as_slice(),
            b"GET / HTTP/1.1\r\nHost: app.example.test\r\nConnection: Upgrade\r\nUpgrade: h2c\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n".as_slice(),
            b"GET / HTTP/1.1\r\nHost: app.example.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n".as_slice(),
            b"GET / HTTP/1.1\r\nHost: app.example.test\r\nConnection: Upgrade\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n".as_slice(),
            b"GET / HTTP/1.1\r\nHost: app.example.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 12\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n".as_slice(),
            b"GET / HTTP/1.1\r\nHost: app.example.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: invalid\r\n\r\n".as_slice(),
            b"GET / HTTP/1.1\r\nHost: app.example.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nTransfer-Encoding: chunked\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n".as_slice(),
            b"GET / HTTP/1.1\r\nHost: app.example.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nExpect: 100-continue\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n".as_slice(),
            b"CONNECT app.example.test:443 HTTP/1.1\r\nHost: app.example.test\r\n\r\n".as_slice(),
        ] {
            assert!(request_plan(invalid).is_err());
        }
    }

    #[test]
    fn validates_the_upstream_websocket_handshake_before_relay() {
        let expected = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=";
        assert!(validate_websocket_response(
            b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n",
            expected,
        )
        .is_ok());
        for invalid in [
            b"HTTP/1.1 200 OK\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n".as_slice(),
            b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: wrong\r\n\r\n".as_slice(),
            b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n".as_slice(),
            b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nContent-Length: 0\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n".as_slice(),
        ] {
            assert!(validate_websocket_response(invalid, expected).is_err());
        }
    }

    #[tokio::test]
    async fn rejects_a_terminated_header_larger_than_the_limit() {
        let (mut writer, mut reader) = tokio::io::duplex(MAX_REQUEST_HEADER_BYTES + 2048);
        let mut oversized = b"GET / HTTP/1.1\r\nHost: app.example.test\r\nX-Fill: ".to_vec();
        oversized.resize(MAX_REQUEST_HEADER_BYTES + 1, b'a');
        oversized.extend_from_slice(b"\r\n\r\n");
        let write = tokio::spawn(async move { writer.write_all(&oversized).await });

        assert!(read_request_head(&mut reader).await.is_err());
        write.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn silent_tls_clients_are_closed_by_the_handshake_deadline() {
        rustls::crypto::ring::default_provider()
            .install_default()
            .ok();
        let resolver = Arc::new(SnapshotCertResolver {
            store: Arc::new(SnapshotStore::default()),
        });
        let config = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_cert_resolver(resolver);
        let acceptor = TlsAcceptor::from(Arc::new(config));
        let (_silent_client, server) = tokio::io::duplex(1024);

        let Err(error) =
            accept_tls_with_deadline(&acceptor, server, Duration::from_millis(5)).await
        else {
            panic!("silent TLS client unexpectedly completed a handshake");
        };

        assert!(error.to_string().contains("deadline exceeded"));
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

    #[test]
    fn route_removal_invalidates_an_existing_authority_tuple() {
        let store = SnapshotStore::default();
        let route = Route {
            binding_id: "binding-a".into(),
            hostname: "app.example.test".into(),
            domain_pool_id: "pool-a".into(),
            owner_id: "user-a".into(),
            container_id: "container-a".into(),
            runtime_id: "runtime-a".into(),
            target_ip: "10.0.0.2".into(),
            target_port: 8080,
        };
        assert!(store
            .store(ProxySnapshot {
                generation: 1,
                stale_after_ms: 30_000,
                valid_until_ms: now_ms() + 30_000,
                routes: vec![route.clone()],
                domain_pools: Vec::new(),
            })
            .unwrap()
            .is_some());
        assert!(store.route_is_current(&route));
        assert!(store
            .store(ProxySnapshot {
                generation: 2,
                stale_after_ms: 30_000,
                valid_until_ms: now_ms() + 30_000,
                routes: Vec::new(),
                domain_pools: Vec::new(),
            })
            .unwrap()
            .is_some());
        assert!(!store.route_is_current(&route));
    }

    #[test]
    fn a_removed_then_readded_route_cannot_revive_an_existing_request() {
        let store = SnapshotStore::default();
        let route = test_route(8080);
        store
            .store(test_snapshot(1, 30_000, vec![route.clone()]))
            .unwrap();
        let authorization = store.authorize_route(&route.hostname).unwrap();

        store.store(test_snapshot(2, 30_000, Vec::new())).unwrap();
        store.store(test_snapshot(3, 30_000, vec![route])).unwrap();

        assert!(!store.authorization_is_current(&authorization));
    }

    #[test]
    fn runtime_identity_change_revokes_even_when_the_network_target_is_reused() {
        let store = SnapshotStore::default();
        let route = test_route(8080);
        store
            .store(test_snapshot(1, 30_000, vec![route.clone()]))
            .unwrap();
        let authorization = store.authorize_route(&route.hostname).unwrap();
        let mut replacement = route;
        replacement.container_id = "container-b".into();
        replacement.runtime_id = "runtime-b".into();

        store
            .store(test_snapshot(2, 30_000, vec![replacement]))
            .unwrap();

        assert!(!store.authorization_is_current(&authorization));
    }

    fn websocket_test_plan() -> (Vec<u8>, String) {
        let plan = request_plan(
            b"GET /socket HTTP/1.1\r\nHost: app.example.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
        )
        .unwrap();
        let RequestMode::WebSocket { expected_accept } = plan.mode else {
            panic!("expected WebSocket request plan");
        };
        (plan.header, expected_accept)
    }

    fn websocket_accept_response(expected_accept: &str) -> Vec<u8> {
        format!(
            "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: {expected_accept}\r\n\r\n"
        )
        .into_bytes()
    }

    #[tokio::test]
    async fn valid_websocket_upgrade_relays_bidirectional_bytes() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_port = listener.local_addr().unwrap().port();
        let (header, expected_accept) = websocket_test_plan();
        let response = websocket_accept_response(&expected_accept);
        let upstream = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_request_head(&mut socket).await.unwrap();
            assert!(String::from_utf8(request)
                .unwrap()
                .contains("Connection: Upgrade\r\n"));
            socket.write_all(&response).await.unwrap();
            let mut from_client = [0_u8; 17];
            socket.read_exact(&mut from_client).await.unwrap();
            assert_eq!(&from_client, b"client-frame-data");
            socket.write_all(b"server-frame-data").await.unwrap();
            socket.shutdown().await.unwrap();
        });

        let route = test_route(upstream_port);
        let runtime = test_runtime();
        let task_runtime = runtime.clone();
        let (mut client, mut proxy_side) = tokio::io::duplex(4096);
        let proxy = tokio::spawn(async move {
            proxy_websocket_upgrade(
                &mut proxy_side,
                &task_runtime,
                &route,
                header,
                &expected_accept,
                Duration::from_secs(1),
            )
            .await
        });

        let response = read_response_head(&mut client).await.unwrap();
        assert!(String::from_utf8(response)
            .unwrap()
            .starts_with("HTTP/1.1 101"));
        client.write_all(b"client-frame-data").await.unwrap();
        let mut from_server = [0_u8; 17];
        client.read_exact(&mut from_server).await.unwrap();
        assert_eq!(&from_server, b"server-frame-data");
        client.shutdown().await.unwrap();

        time::timeout(Duration::from_secs(1), proxy)
            .await
            .expect("WebSocket proxy did not finish")
            .unwrap()
            .unwrap();
        upstream.await.unwrap();
    }

    #[tokio::test]
    async fn websocket_non_101_timeout_and_oversize_fail_closed() {
        async fn run_failure(response: Option<Vec<u8>>, deadline: Duration) -> (String, String) {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let upstream_port = listener.local_addr().unwrap().port();
            let upstream = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let _ = read_request_head(&mut socket).await.unwrap();
                match response {
                    Some(response) => {
                        let _ = socket.write_all(&response).await;
                        let _ = socket.shutdown().await;
                    }
                    None => std::future::pending::<()>().await,
                }
            });
            let (header, expected_accept) = websocket_test_plan();
            let route = test_route(upstream_port);
            let runtime = test_runtime();
            let (mut client, mut proxy_side) = tokio::io::duplex(4096);
            let error = proxy_websocket_upgrade(
                &mut proxy_side,
                &runtime,
                &route,
                header,
                &expected_accept,
                deadline,
            )
            .await
            .unwrap_err()
            .to_string();
            let mut rejection = Vec::new();
            client.read_to_end(&mut rejection).await.unwrap();
            upstream.abort();
            let _ = upstream.await;
            (error, String::from_utf8(rejection).unwrap())
        }

        let (error, rejection) = run_failure(
            Some(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n".to_vec()),
            Duration::from_secs(1),
        )
        .await;
        assert!(error.contains("did not accept"));
        assert!(rejection.starts_with("HTTP/1.1 502 Bad Gateway"));

        let (error, rejection) = run_failure(None, Duration::from_millis(10)).await;
        assert!(error.contains("deadline exceeded"));
        assert!(rejection.starts_with("HTTP/1.1 504 Gateway Timeout"));

        let mut oversized = b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nX-Fill: ".to_vec();
        oversized.resize(MAX_UPSTREAM_UPGRADE_HEADER_BYTES + 1, b'a');
        oversized.extend_from_slice(b"\r\n\r\n");
        let (error, rejection) = run_failure(Some(oversized), Duration::from_secs(1)).await;
        assert!(error.contains("too large"));
        assert!(rejection.starts_with("HTTP/1.1 502 Bad Gateway"));
    }

    #[tokio::test]
    async fn websocket_tunnel_closes_when_route_authority_is_revoked() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_port = listener.local_addr().unwrap().port();
        let (_, expected_accept) = websocket_test_plan();
        let response = websocket_accept_response(&expected_accept);
        let upstream = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let _ = read_request_head(&mut socket).await.unwrap();
            socket.write_all(&response).await.unwrap();
            let mut byte = [0_u8; 1];
            let _ = socket.read(&mut byte).await;
        });

        let route = test_route(upstream_port);
        let store = Arc::new(SnapshotStore::default());
        store.store(test_snapshot(1, 30_000, vec![route])).unwrap();
        let runtime = test_runtime();
        let (mut client, proxy_side) = tokio::io::duplex(4096);
        let handler_store = store.clone();
        let handler = tokio::spawn(handle_connection_with_fixed_request_deadline(
            proxy_side,
            "127.0.0.1:12345".parse().unwrap(),
            handler_store,
            runtime,
            Duration::from_millis(10),
        ));
        client
            .write_all(b"GET /socket HTTP/1.1\r\nHost: app.example.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n")
            .await
            .unwrap();
        let response = read_response_head(&mut client).await.unwrap();
        assert!(String::from_utf8(response)
            .unwrap()
            .starts_with("HTTP/1.1 101"));

        time::sleep(Duration::from_millis(30)).await;
        assert!(
            !handler.is_finished(),
            "WebSocket tunnel inherited the ordinary HTTP request deadline"
        );

        store.store(test_snapshot(2, 30_000, Vec::new())).unwrap();
        let result = time::timeout(Duration::from_secs(1), handler)
            .await
            .expect("revoked WebSocket tunnel did not close")
            .unwrap();
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("authorization was revoked"));
        let mut byte = [0_u8; 1];
        assert_eq!(client.read(&mut byte).await.unwrap(), 0);
        upstream.await.unwrap();
    }

    #[tokio::test]
    async fn fixed_http_request_retains_the_absolute_lifetime_deadline() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_port = listener.local_addr().unwrap().port();
        let upstream = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let _ = read_request_head(&mut socket).await.unwrap();
            std::future::pending::<()>().await;
        });
        let route = test_route(upstream_port);
        let store = Arc::new(SnapshotStore::default());
        store.store(test_snapshot(1, 30_000, vec![route])).unwrap();
        let runtime = test_runtime();
        let (mut client, proxy_side) = tokio::io::duplex(4096);
        let handler = tokio::spawn(handle_connection_with_fixed_request_deadline(
            proxy_side,
            "127.0.0.1:12345".parse().unwrap(),
            store,
            runtime,
            Duration::from_millis(10),
        ));
        client
            .write_all(b"GET /slow HTTP/1.1\r\nHost: app.example.test\r\n\r\n")
            .await
            .unwrap();

        let result = time::timeout(Duration::from_secs(1), handler)
            .await
            .expect("fixed HTTP request did not reach its lifetime deadline")
            .unwrap();
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("request lifetime deadline exceeded"));
        upstream.abort();
    }

    #[tokio::test]
    async fn early_websocket_bytes_are_rejected_as_smuggling() {
        let route = test_route(9);
        let runtime = test_runtime();
        let (header, _) = websocket_test_plan();
        let header_end = header.len();
        let mut received = header.clone();
        received.extend_from_slice(b"early-frame");
        let plan = request_plan(&header).unwrap();
        let (mut client, mut proxy_side) = tokio::io::duplex(1024);
        let error = proxy_request(
            &mut proxy_side,
            &runtime,
            &route,
            received,
            header_end,
            plan,
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("early WebSocket data"));
        let mut response = Vec::new();
        client.read_to_end(&mut response).await.unwrap();
        assert!(String::from_utf8(response)
            .unwrap()
            .starts_with("HTTP/1.1 400 Bad Request"));
    }

    #[tokio::test]
    async fn snapshot_expiry_interrupts_an_established_slow_request() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_port = listener.local_addr().unwrap().port();
        let upstream = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 1024];
            let _ = socket.read(&mut request).await.unwrap();
            std::future::pending::<()>().await;
        });

        let route = test_route(upstream_port);
        let store = Arc::new(SnapshotStore::default());
        install_snapshot(&store, test_snapshot(1, 50, vec![route])).unwrap();
        let runtime = test_runtime();
        let (mut client, proxy_side) = tokio::io::duplex(4096);
        let handler = tokio::spawn(handle_connection(
            proxy_side,
            "127.0.0.1:12345".parse().unwrap(),
            store,
            runtime,
        ));
        client
            .write_all(b"GET /slow HTTP/1.1\r\nHost: app.example.test\r\n\r\n")
            .await
            .unwrap();

        let result = time::timeout(Duration::from_secs(2), handler)
            .await
            .expect("request did not stop at snapshot expiry")
            .unwrap();
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("authorization was revoked"));
        upstream.abort();
    }

    fn test_snapshot(generation: u64, stale_after_ms: u64, routes: Vec<Route>) -> ProxySnapshot {
        ProxySnapshot {
            generation,
            stale_after_ms,
            valid_until_ms: now_ms() + stale_after_ms,
            routes,
            domain_pools: Vec::new(),
        }
    }

    fn test_route(target_port: u16) -> Route {
        Route {
            binding_id: "binding-a".into(),
            hostname: "app.example.test".into(),
            domain_pool_id: "pool-a".into(),
            owner_id: "user-a".into(),
            container_id: "container-a".into(),
            runtime_id: "runtime-a".into(),
            target_ip: "127.0.0.1".into(),
            target_port,
        }
    }

    fn test_runtime() -> Arc<Runtime> {
        Arc::new(Runtime {
            proxy_id: "proxy-test".into(),
            hostname: Some("proxy.test".into()),
            http_listen: "127.0.0.1:0".into(),
            https_listen: None,
            started_at: Instant::now(),
            connected_at: AtomicU64::new(0),
            last_snapshot_generation: AtomicU64::new(0),
            last_snapshot_at: AtomicU64::new(0),
            active_connections: AtomicU64::new(0),
            total_requests: AtomicU64::new(0),
            total_rejected_requests: AtomicU64::new(0),
        })
    }
}
