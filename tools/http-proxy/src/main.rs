use std::collections::HashMap;
use std::io::BufReader;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use arc_swap::ArcSwapOption;
use futures_util::{SinkExt, StreamExt};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime};
use rustls::server::{ClientHello, ResolvesServerCert};
use rustls::sign::CertifiedKey;
use rustls::{DigitallySignedStruct, SignatureScheme};
use serde::{Deserialize, Serialize};
use tokio::io::{self, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::time;
use tokio_rustls::{TlsAcceptor, TlsConnector};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use tracing::{debug, info, warn};

#[derive(Clone, Debug)]
struct Config {
    backend_ws: String,
    token: String,
    http_listen: String,
    https_listen: Option<String>,
    reconnect_delay: Duration,
    status_interval: Duration,
}

impl Config {
    fn from_env() -> Result<Self> {
        let backend_ws = std::env::var("NYABASE_BACKEND_WS")
            .unwrap_or_else(|_| "ws://127.0.0.1:3000/ws/http-proxy".to_string());
        let token = std::env::var("NYABASE_HTTP_PROXY_TOKEN")
            .or_else(|_| std::env::var("HTTP_PROXY_TOKEN"))
            .unwrap_or_default();
        let http_listen = std::env::var("NYABASE_HTTP_LISTEN")
            .unwrap_or_else(|_| "0.0.0.0:8080".to_string());
        let https_listen = std::env::var("NYABASE_HTTPS_LISTEN").ok().filter(|value| !value.trim().is_empty());
        let reconnect_delay = Duration::from_millis(env_u64("NYABASE_BACKEND_RECONNECT_MS", 2_000));
        let status_interval = Duration::from_millis(env_u64("NYABASE_HTTP_STATUS_INTERVAL_MS", 1_000).max(250));
        Ok(Self { backend_ws, token, http_listen, https_listen, reconnect_delay, status_interval })
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
        self.current.store(Some(Arc::new(RoutingSnapshot::from(snapshot))));
        info!(generation, route_count, "installed HTTP proxy snapshot");
    }

    fn load(&self) -> Option<Arc<RoutingSnapshot>> {
        self.current.load_full()
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
    routes: HashMap<String, Route>,
    certs: Vec<DomainCert>,
}

impl From<ProxySnapshot> for RoutingSnapshot {
    fn from(snapshot: ProxySnapshot) -> Self {
        let routes = snapshot.routes.into_iter()
            .map(|route| (route.hostname.clone(), route))
            .collect::<HashMap<_, _>>();
        let certs = snapshot.domain_pools.into_iter()
            .filter_map(|pool| DomainCert::from_pool(pool).ok())
            .collect::<Vec<_>>();
        Self { generation: snapshot.generation, routes, certs }
    }
}

#[derive(Clone, Debug)]
struct DomainCert {
    wildcard_domain: String,
    key: Arc<CertifiedKey>,
}

impl DomainCert {
    fn from_pool(pool: DomainPool) -> Result<Self> {
        let cert_pem = pool.certificate_pem.context("missing certificate")?;
        let key_pem = pool.private_key_pem.context("missing private key")?;
        let mut cert_reader = BufReader::new(cert_pem.as_bytes());
        let certs = rustls_pemfile::certs(&mut cert_reader)
            .collect::<std::result::Result<Vec<CertificateDer<'static>>, _>>()?;
        let mut key_reader = BufReader::new(key_pem.as_bytes());
        let key = rustls_pemfile::private_key(&mut key_reader)?
            .ok_or_else(|| anyhow!("missing private key"))?;
        let signing_key = rustls::crypto::ring::sign::any_supported_type(&key)?;
        Ok(Self {
            wildcard_domain: pool.wildcard_domain,
            key: Arc::new(CertifiedKey::new(certs, signing_key)),
        })
    }
}

#[derive(Debug)]
struct SnapshotCertResolver {
    store: Arc<SnapshotStore>,
}

impl ResolvesServerCert for SnapshotCertResolver {
    fn resolve(&self, hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        let sni = hello.server_name()?.trim_end_matches('.').to_ascii_lowercase();
        let snapshot = self.store.load()?;
        snapshot.certs.iter()
            .find(|cert| hostname_matches_wildcard(&sni, &cert.wildcard_domain))
            .or_else(|| snapshot.certs.first())
            .map(|cert| cert.key.clone())
    }
}

#[derive(Debug)]
struct NoVerifier;

impl ServerCertVerifier for NoVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> std::result::Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![
            SignatureScheme::RSA_PKCS1_SHA256,
            SignatureScheme::ECDSA_NISTP256_SHA256,
            SignatureScheme::RSA_PSS_SHA256,
            SignatureScheme::ED25519,
        ]
    }
}

#[derive(Clone, Debug, Deserialize)]
struct ProxySnapshot {
    generation: u64,
    routes: Vec<Route>,
    #[serde(rename = "domainPools")]
    domain_pools: Vec<DomainPool>,
}

#[derive(Clone, Debug, Deserialize)]
struct Route {
    #[serde(rename = "bindingId")]
    binding_id: String,
    hostname: String,
    #[serde(rename = "targetIp")]
    target_ip: String,
    #[serde(rename = "targetPort")]
    target_port: u16,
    #[serde(rename = "targetProtocol")]
    target_protocol: TargetProtocol,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum TargetProtocol {
    Http,
    Https,
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
    rustls::crypto::ring::default_provider().install_default().ok();

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

    tokio::spawn(control_loop(config.clone(), store.clone(), runtime.clone(), status_rx));
    tokio::spawn(status_loop(config.clone(), runtime.clone(), status_tx));
    tokio::spawn(http_listener(config.http_listen.clone(), store.clone(), runtime.clone(), false));
    if let Some(listen) = config.https_listen.clone() {
        tokio::spawn(http_listener(listen, store, runtime, true));
    }

    tokio::signal::ctrl_c().await?;
    Ok(())
}

async fn control_loop(
    config: Config,
    store: Arc<SnapshotStore>,
    runtime: Arc<Runtime>,
    mut status_rx: mpsc::Receiver<String>,
) {
    loop {
        match connect_control(&config, &store, &runtime, &mut status_rx).await {
            Ok(()) => warn!("HTTP proxy control connection closed"),
            Err(error) => warn!(%error, "HTTP proxy control connection failed"),
        }
        time::sleep(config.reconnect_delay).await;
    }
}

async fn connect_control(
    config: &Config,
    store: &Arc<SnapshotStore>,
    runtime: &Arc<Runtime>,
    status_rx: &mut mpsc::Receiver<String>,
) -> Result<()> {
    let mut request = config.backend_ws.clone().into_client_request()?;
    if !config.token.is_empty() {
        request.headers_mut().insert(
            "Authorization",
            format!("Bearer {}", config.token).parse()?,
        );
    }
    let (ws, _) = connect_async(request).await?;
    runtime.connected_at.store(now_ms(), Ordering::Relaxed);
    let (mut write, mut read) = ws.split();
    loop {
        tokio::select! {
            Some(message) = read.next() => {
                let message = message?;
                if !message.is_text() { continue; }
                let envelope: Envelope = serde_json::from_str(message.to_text()?)?;
                if envelope.kind == "snapshot" || envelope.kind == "update" {
                    let snapshot: ProxySnapshot = serde_json::from_value(envelope.payload)?;
                    runtime.last_snapshot_generation.store(snapshot.generation, Ordering::Relaxed);
                    runtime.last_snapshot_at.store(now_ms(), Ordering::Relaxed);
                    let ack = serde_json::json!({"kind":"ack","payload":{"generation":snapshot.generation}});
                    store.store(snapshot);
                    write.send(Message::Text(ack.to_string().into())).await?;
                }
            }
            Some(status) = status_rx.recv() => {
                write.send(Message::Text(status.into())).await?;
            }
            else => break,
        }
    }
    Ok(())
}

async fn status_loop(config: Config, runtime: Arc<Runtime>, status_tx: mpsc::Sender<String>) {
    let mut interval = time::interval(config.status_interval);
    loop {
        interval.tick().await;
        let last_generation = runtime.last_snapshot_generation.load(Ordering::Relaxed);
        let last_at = runtime.last_snapshot_at.load(Ordering::Relaxed);
        let report = StatusReport {
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
        if let Ok(encoded) = serde_json::to_string(&report) {
            let _ = status_tx.send(encoded).await;
        }
    }
}

async fn http_listener(
    listen: String,
    store: Arc<SnapshotStore>,
    runtime: Arc<Runtime>,
    tls: bool,
) -> Result<()> {
    let listener = TcpListener::bind(&listen).await?;
    info!(listen, tls, "HTTP proxy listener ready");
    let acceptor = if tls {
        let resolver = Arc::new(SnapshotCertResolver { store: store.clone() });
        let tls_config = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_cert_resolver(resolver);
        Some(TlsAcceptor::from(Arc::new(tls_config)))
    } else {
        None
    };
    loop {
        let (stream, peer) = listener.accept().await?;
        let store = store.clone();
        let runtime = runtime.clone();
        let acceptor = acceptor.clone();
        tokio::spawn(async move {
            runtime.active_connections.fetch_add(1, Ordering::Relaxed);
            let result = if let Some(acceptor) = acceptor {
                match acceptor.accept(stream).await {
                    Ok(tls_stream) => handle_connection(tls_stream, peer, store, runtime.clone()).await,
                    Err(error) => Err(anyhow!(error)),
                }
            } else {
                handle_connection(stream, peer, store, runtime.clone()).await
            };
            runtime.active_connections.fetch_sub(1, Ordering::Relaxed);
            if let Err(error) = result {
                debug!(%peer, %error, "request handling failed");
            }
        });
    }
}

async fn handle_connection<S>(
    mut inbound: S,
    _peer: SocketAddr,
    store: Arc<SnapshotStore>,
    runtime: Arc<Runtime>,
) -> Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    runtime.total_requests.fetch_add(1, Ordering::Relaxed);
    let mut head = Vec::with_capacity(4096);
    let mut buf = [0_u8; 1024];
    loop {
        let n = inbound.read(&mut buf).await?;
        if n == 0 {
            return Ok(());
        }
        head.extend_from_slice(&buf[..n]);
        if head.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
        if head.len() > 64 * 1024 {
            runtime.total_rejected_requests.fetch_add(1, Ordering::Relaxed);
            inbound.write_all(b"HTTP/1.1 431 Request Header Fields Too Large\r\nContent-Length: 0\r\n\r\n").await?;
            return Ok(());
        }
    }
    let host = parse_host(&head);
    let Some(host) = host else {
        runtime.total_rejected_requests.fetch_add(1, Ordering::Relaxed);
        inbound.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n").await?;
        return Ok(());
    };
    let Some(route) = store.load().and_then(|snapshot| snapshot.routes.get(&host).cloned()) else {
        runtime.total_rejected_requests.fetch_add(1, Ordering::Relaxed);
        inbound.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n").await?;
        return Ok(());
    };
    let upstream_addr = format!("{}:{}", route.target_ip, route.target_port);
    let upstream = match TcpStream::connect(&upstream_addr).await {
        Ok(stream) => stream,
        Err(_) => {
            runtime.total_rejected_requests.fetch_add(1, Ordering::Relaxed);
            inbound.write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n").await?;
            return Ok(());
        }
    };
    if route.target_protocol == TargetProtocol::Https {
        let connector = https_connector();
        let name = ServerName::try_from(host.clone()).unwrap_or(ServerName::IpAddress(std::net::IpAddr::from([127, 0, 0, 1]).into()));
        let mut upstream = connector.connect(name, upstream).await?;
        upstream.write_all(&head).await?;
        let _ = io::copy_bidirectional(&mut inbound, &mut upstream).await;
    } else {
        let mut upstream = upstream;
        upstream.write_all(&head).await?;
        let _ = io::copy_bidirectional(&mut inbound, &mut upstream).await;
    }
    debug!(binding_id = %route.binding_id, hostname = %host, "proxied request");
    Ok(())
}

fn https_connector() -> TlsConnector {
    let config = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(NoVerifier))
        .with_no_client_auth();
    TlsConnector::from(Arc::new(config))
}

fn parse_host(head: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(head).ok()?;
    text.lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("host").then(|| value.trim().split(':').next().unwrap_or("").trim_end_matches('.').to_ascii_lowercase())
        })
        .filter(|value| !value.is_empty())
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

fn env_u64(name: &str, fallback: u64) -> u64 {
    std::env::var(name).ok().and_then(|value| value.parse().ok()).unwrap_or(fallback)
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

    #[test]
    fn parses_host_header() {
        let head = b"GET / HTTP/1.1\r\nHost: App.Example.test:8080\r\n\r\n";
        assert_eq!(parse_host(head).as_deref(), Some("app.example.test"));
    }

    #[test]
    fn matches_single_label_wildcard() {
        assert!(hostname_matches_wildcard("app.example.test", "*.example.test"));
        assert!(!hostname_matches_wildcard("deep.app.example.test", "*.example.test"));
    }
}
