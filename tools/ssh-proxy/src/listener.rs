use crate::bridge::emit_metric;
use crate::config::ProxyConfig;
use crate::control::ControlPlane;
use crate::protocol::TelemetrySender;
use crate::proxy_protocol::{read_client_address, PROXY_HEADER_TIMEOUT};
use crate::runtime::{ConnectionCleanup, ConnectionState, ProxyRuntime};
use crate::session::ProxySshSession;
use crate::snapshot::SnapshotStore;
use anyhow::{anyhow, Context, Result};
use futures_util::future::Abortable;
use proxy_common::accept::accept_retrying;
use proxy_common::conn_limit::{
    wait_evicted, ConnectionLimiter, ConnectionPermit, LimitRejection, PendingEviction,
    PendingPermit,
};
use russh::{MethodKind, MethodSet};
use std::future::Future;
use std::net::{IpAddr, Shutdown, SocketAddr};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Semaphore;
use tracing::{debug, info, warn};

pub(crate) async fn run_public_listener(
    config: ProxyConfig,
    store: Arc<SnapshotStore>,
    runtime: Arc<ProxyRuntime>,
    control: Arc<ControlPlane>,
    telemetry: TelemetrySender,
) -> Result<()> {
    let listener = TcpListener::bind(&config.listen).await?;
    info!(
        listen = %config.listen,
        proxy_protocol_trusted = %config.proxy_protocol_trusted,
        "SSH proxy listener started"
    );
    serve_public(listener, config, store, runtime, control, telemetry).await
}

pub(crate) async fn serve_public(
    listener: TcpListener,
    config: ProxyConfig,
    store: Arc<SnapshotStore>,
    runtime: Arc<ProxyRuntime>,
    control: Arc<ControlPlane>,
    telemetry: TelemetrySender,
) -> Result<()> {
    let admission = Arc::new(Admission {
        limiter: ConnectionLimiter::new(config.connection_limits()),
        header_reads: Arc::new(Semaphore::new(config.max_preauth_connections)),
        config,
        store,
        runtime,
        control,
        telemetry,
    });
    loop {
        let (stream, peer) = accept_retrying(
            || listener.accept(),
            |error, delay| {
                warn!(%error, retry_ms = delay.as_millis() as u64, "SSH proxy accept failed");
            },
        )
        .await;
        if admission.config.proxy_protocol_trusted.contains(peer.ip()) {
            admission.admit_after_proxy_header(stream, peer);
        } else {
            admission.admit(stream, peer);
        }
    }
}

struct Admission {
    limiter: Arc<ConnectionLimiter>,
    /// Trusted-relay connections whose PROXY header is still being read.
    header_reads: Arc<Semaphore>,
    config: ProxyConfig,
    store: Arc<SnapshotStore>,
    runtime: Arc<ProxyRuntime>,
    control: Arc<ControlPlane>,
    telemetry: TelemetrySender,
}

impl Admission {
    /// The header is read off the accept loop and before any limit is taken:
    /// limits and history are per client, and until the header is read the
    /// only known address is the relay's, which all its clients share. Reads
    /// in flight are bounded by the pre-auth pool size and each by
    /// `PROXY_HEADER_TIMEOUT`.
    fn admit_after_proxy_header(self: &Arc<Self>, mut stream: TcpStream, relay: SocketAddr) {
        let Ok(slot) = self.header_reads.clone().try_acquire_owned() else {
            warn!(%relay, "PROXY header reads at capacity; connection rejected");
            self.reject(relay.ip(), "rejected_preauth_limit");
            return;
        };
        let admission = self.clone();
        tokio::spawn(async move {
            let client = read_client_address(&mut stream, relay, PROXY_HEADER_TIMEOUT).await;
            drop(slot);
            match client {
                Ok(client) => {
                    if client != relay {
                        debug!(%client, %relay, "PROXY header names the client");
                    }
                    admission.admit(stream, client);
                }
                Err(error) => {
                    warn!(%relay, %error, "invalid PROXY header; connection rejected");
                    admission.reject(relay.ip(), "proxy_header_invalid");
                }
            }
        });
    }

    /// `peer` is the client: the socket peer, or the address a trusted
    /// relay's PROXY header named.
    fn admit(&self, stream: TcpStream, peer: SocketAddr) {
        // The permit is held by the connection task until the session ends,
        // so one address cannot exhaust the pool before authenticating.
        let permit = match self.limiter.try_acquire(peer.ip()) {
            Ok(permit) => permit,
            Err(limit) => {
                warn!(%peer, limit = limit.as_str(), "connection rejected by concurrency limit");
                self.reject(
                    peer.ip(),
                    match limit {
                        LimitRejection::Global => "rejected_limit",
                        LimitRejection::PerClient => "rejected_client_limit",
                        LimitRejection::PerSite => "rejected_site_limit",
                        LimitRejection::Pending => "rejected_preauth_limit",
                    },
                );
                return;
            }
        };
        if !self.control.admit() && self.store.load().is_none() {
            warn!(%peer, "SSH proxy rejected paused connection without host key");
            self.reject(peer.ip(), "rejected_paused");
            let _ = stream
                .into_std()
                .map(|socket| socket.shutdown(Shutdown::Both));
            return;
        }
        let admit = self.control.admit();
        tokio::spawn(serve_connection(
            stream,
            peer,
            permit,
            admit,
            self.store.clone(),
            self.control.clone(),
            self.config.clone(),
            self.runtime.clone(),
            self.telemetry.clone(),
        ));
    }

    fn reject(&self, ip: IpAddr, result: &'static str) {
        self.runtime.record_rejected_connection();
        self.runtime.history.refuse(ip, result);
        emit_metric(
            &self.telemetry,
            "ssh_proxy_connections_total",
            vec![("result", result.to_string())],
            1.0,
        );
    }
}

// Mirrors handle_ssh_connection's explicit per-connection state.
#[allow(clippy::too_many_arguments)]
async fn serve_connection(
    stream: TcpStream,
    peer: SocketAddr,
    mut permit: ConnectionPermit,
    admit: bool,
    store: Arc<SnapshotStore>,
    control: Arc<ControlPlane>,
    config: ProxyConfig,
    runtime: Arc<ProxyRuntime>,
    telemetry: TelemetrySender,
) {
    let auth_timeout = config.auth_timeout;
    if admit {
        let (connection, abort_registration) = runtime.register_connection(peer);
        // The pre-auth slot moves to the connection, which drops it once
        // public-key authentication succeeds; the main slot stays here.
        let pending = permit.take_pending();
        let eviction = pending.as_ref().map(PendingPermit::eviction);
        connection.hold_pending(pending);
        let _permit = permit;
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
            with_auth_deadline(
                handle_ssh_connection(
                    stream,
                    peer,
                    store,
                    control,
                    config,
                    telemetry.clone(),
                    connection.clone(),
                    false,
                ),
                &connection,
                auth_timeout,
                eviction.clone(),
            ),
            abort_registration,
        )
        .await;
        match connection_result {
            Ok(Err(error)) => {
                debug!(%peer, %error, "SSH connection closed");
                let evicted = eviction.as_ref().is_some_and(PendingEviction::is_evicted);
                connection.set_close_reason(if evicted {
                    "preauth_evicted"
                } else {
                    close_reason(&error)
                });
                let result = if evicted {
                    "closed_preauth_evicted"
                } else {
                    "closed_error"
                };
                emit_metric(
                    &telemetry,
                    "ssh_proxy_connections_total",
                    vec![("result", result.to_string())],
                    1.0,
                );
            }
            Err(_) => {
                debug!(%peer, "SSH connection was revoked and aborted");
                connection.set_close_reason("aborted");
            }
            Ok(Ok(())) => connection.set_close_reason("client_closed"),
        }
        return;
    }
    // Never authenticates, so it keeps its pre-auth slot to the end.
    let eviction = permit.take_pending().map(|pending| {
        let eviction = pending.eviction();
        (pending, eviction)
    });
    let _permit = permit;
    runtime.record_rejected_connection();
    let (connection, _abort_registration) = ConnectionState::new(0, peer);
    let connection = Arc::new(connection);
    // The paused reject path never yields an authenticated session, so the
    // whole exchange is bounded by the authentication deadline.
    let result = tokio::select! {
        biased;
        _ = wait_evicted(eviction.as_ref().map(|(_, eviction)| eviction)) => {
            Ok(Err(anyhow!("pre-auth connection evicted to admit a lighter client")))
        }
        result = tokio::time::timeout(
            auth_timeout,
            handle_ssh_connection(
                stream,
                peer,
                store,
                control,
                config,
                telemetry.clone(),
                connection,
                true,
            ),
        ) => result,
    };
    match result {
        Ok(Ok(())) => {}
        Ok(Err(error)) => debug!(%peer, %error, "paused SSH reject path closed"),
        Err(_) => debug!(%peer, "paused SSH reject path hit the authentication deadline"),
    }
    runtime.history.refuse(peer.ip(), "rejected_paused");
    emit_metric(
        &telemetry,
        "ssh_proxy_connections_total",
        vec![("result", "rejected_paused".to_string())],
        1.0,
    );
}

/// Why a session that ended with `error` closed, as recorded in its history.
pub(crate) fn close_reason(error: &anyhow::Error) -> &'static str {
    if error.to_string() == AUTH_DEADLINE_EXCEEDED {
        return "auth_timeout";
    }
    if let Some(error) = error.downcast_ref::<russh::Error>() {
        return match error {
            russh::Error::KeepaliveTimeout => "keepalive_timeout",
            russh::Error::InactivityTimeout => "idle_timeout",
            russh::Error::Disconnect | russh::Error::HUP => "client_closed",
            russh::Error::IO(_) => "network_error",
            _ => "protocol_error",
        };
    }
    if error.downcast_ref::<std::io::Error>().is_some() {
        return "network_error";
    }
    "error"
}

const AUTH_DEADLINE_EXCEEDED: &str = "SSH authentication deadline exceeded";

/// Closes the session if public-key authentication has not succeeded within
/// `deadline` of accept, or if its pre-auth slot is evicted for a lighter
/// client before then. The deadline is independent of (and much shorter
/// than) the session inactivity timeout, so idle pre-auth sockets cannot pin
/// slots. An authenticated session has released its slot, which can then no
/// longer be evicted.
pub(crate) async fn with_auth_deadline<F>(
    session: F,
    connection: &ConnectionState,
    deadline: Duration,
    eviction: Option<PendingEviction>,
) -> Result<()>
where
    F: Future<Output = Result<()>>,
{
    tokio::select! {
        result = session => result,
        _ = auth_deadline_elapsed(connection, deadline) => {
            Err(anyhow!(AUTH_DEADLINE_EXCEEDED))
        }
        _ = wait_evicted(eviction.as_ref()) => {
            Err(anyhow!("SSH pre-auth connection evicted to admit a lighter client"))
        }
    }
}

async fn auth_deadline_elapsed(connection: &ConnectionState, deadline: Duration) {
    tokio::time::sleep(deadline).await;
    if connection.authenticated_at.load(Ordering::Acquire) != 0 {
        std::future::pending::<()>().await;
    }
}

// Per-connection state is passed explicitly so restart handoff can construct
// it without a shared context type; revisit when main.rs is split into modules.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn handle_ssh_connection(
    stream: TcpStream,
    peer: SocketAddr,
    store: Arc<SnapshotStore>,
    control: Arc<ControlPlane>,
    config: ProxyConfig,
    telemetry: TelemetrySender,
    connection: Arc<ConnectionState>,
    reject_paused: bool,
) -> Result<()> {
    // russh::server::run_stream returns a RunningSession backed by an internal
    // Tokio JoinHandle. Dropping that value detaches the task, so cancelling
    // this outer connection future alone would otherwise leave the accepted
    // TCP session alive after authorization revocation. Retain a duplicated
    // socket descriptor whose Drop performs shutdown(2) on the shared socket;
    // that wakes both halves owned by russh even if its JoinHandle is detached.
    let (stream, socket_guard) = revocable_session_stream(stream)?;
    let snapshot = if reject_paused {
        store
            .load()
            .context("no held SSH proxy host key is installed")?
    } else {
        store
            .load()
            .filter(|snapshot| snapshot.is_fresh())
            .context("no routing snapshot is installed")?
    };
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
    let handler = ProxySshSession::new(
        store,
        control,
        config,
        peer,
        telemetry,
        connection,
        reject_paused,
    );
    let session = russh::server::run_stream(server_config, stream, handler).await?;
    session.await?;
    socket_guard.shutdown();
    Ok(())
}

pub(crate) struct SessionSocketGuard(pub(crate) std::net::TcpStream);

impl SessionSocketGuard {
    pub(crate) fn shutdown(&self) {
        let _ = self.0.shutdown(Shutdown::Both);
    }
}

impl Drop for SessionSocketGuard {
    fn drop(&mut self) {
        self.shutdown();
    }
}

pub(crate) fn revocable_session_stream(
    stream: TcpStream,
) -> Result<(TcpStream, SessionSocketGuard)> {
    let control = stream
        .into_std()
        .context("failed to retain SSH session socket ownership")?;
    let session = control
        .try_clone()
        .context("failed to duplicate SSH session socket")?;
    session
        .set_nonblocking(true)
        .context("failed to configure duplicated SSH session socket")?;
    Ok((
        TcpStream::from_std(session).context("failed to adopt duplicated SSH session socket")?,
        SessionSocketGuard(control),
    ))
}

#[cfg(test)]
#[path = "listener_tests.rs"]
mod tests;
