use crate::bridge::emit_metric;
use crate::config::ProxyConfig;
use crate::control::ControlPlane;
use crate::protocol::TelemetrySender;
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
use std::net::{Shutdown, SocketAddr};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};
use tracing::{debug, info, warn};

pub(crate) async fn run_public_listener(
    config: ProxyConfig,
    store: Arc<SnapshotStore>,
    runtime: Arc<ProxyRuntime>,
    control: Arc<ControlPlane>,
    telemetry: TelemetrySender,
) -> Result<()> {
    let listener = TcpListener::bind(&config.listen).await?;
    info!(listen = %config.listen, "SSH proxy listener started");
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
    let limiter = ConnectionLimiter::new(config.connection_limits());
    loop {
        let (stream, peer) = accept_retrying(
            || listener.accept(),
            |error, delay| {
                warn!(%error, retry_ms = delay.as_millis() as u64, "SSH proxy accept failed");
            },
        )
        .await;
        // The permit is held by the connection task until the session ends,
        // so one address cannot exhaust the pool before authenticating.
        let permit = match limiter.try_acquire(peer.ip()) {
            Ok(permit) => permit,
            Err(limit) => {
                warn!(%peer, limit = limit.as_str(), "connection rejected by concurrency limit");
                runtime.record_rejected_connection();
                let result = match limit {
                    LimitRejection::Global => "rejected_limit",
                    LimitRejection::PerClient => "rejected_client_limit",
                    LimitRejection::PerSite => "rejected_site_limit",
                    LimitRejection::Pending => "rejected_preauth_limit",
                };
                emit_metric(
                    &telemetry,
                    "ssh_proxy_connections_total",
                    vec![("result", result.to_string())],
                    1.0,
                );
                continue;
            }
        };
        if !control.admit() && store.load().is_none() {
            warn!(%peer, "SSH proxy rejected paused connection without host key");
            runtime.record_rejected_connection();
            emit_metric(
                &telemetry,
                "ssh_proxy_connections_total",
                vec![("result", "rejected_paused".to_string())],
                1.0,
            );
            let _ = stream
                .into_std()
                .map(|socket| socket.shutdown(Shutdown::Both));
            continue;
        }
        let admit = control.admit();
        tokio::spawn(serve_connection(
            stream,
            peer,
            permit,
            admit,
            store.clone(),
            control.clone(),
            config.clone(),
            runtime.clone(),
            telemetry.clone(),
        ));
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
            Err(_) => debug!(%peer, "SSH connection was revoked and aborted"),
            Ok(Ok(())) => {}
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
    emit_metric(
        &telemetry,
        "ssh_proxy_connections_total",
        vec![("result", "rejected_paused".to_string())],
        1.0,
    );
}

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
            Err(anyhow!("SSH authentication deadline exceeded"))
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
