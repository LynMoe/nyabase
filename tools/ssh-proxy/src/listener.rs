use crate::bridge::emit_metric;
use crate::config::ProxyConfig;
use crate::control::ControlPlane;
use crate::protocol::TelemetrySender;
use crate::runtime::{ConnectionCleanup, ConnectionState, ProxyRuntime};
use crate::session::ProxySshSession;
use crate::snapshot::SnapshotStore;
use anyhow::{Context, Result};
use futures_util::future::Abortable;
use russh::{MethodKind, MethodSet};
use std::net::{Shutdown, SocketAddr};
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
        let store = store.clone();
        let control = control.clone();
        let config = config.clone();
        let runtime = runtime.clone();
        let telemetry = telemetry.clone();
        let admit = control.admit();
        tokio::spawn(async move {
            let _permit = permit;
            if admit {
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
                        control,
                        config,
                        telemetry.clone(),
                        connection.clone(),
                        false,
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
                return;
            }
            runtime.record_rejected_connection();
            let (connection, _abort_registration) = ConnectionState::new(0, peer);
            let connection = Arc::new(connection);
            match handle_ssh_connection(
                stream,
                peer,
                store,
                control,
                config,
                telemetry.clone(),
                connection,
                true,
            )
            .await
            {
                Ok(()) => emit_metric(
                    &telemetry,
                    "ssh_proxy_connections_total",
                    vec![("result", "rejected_paused".to_string())],
                    1.0,
                ),
                Err(error) => {
                    debug!(%peer, %error, "paused SSH reject path closed");
                    emit_metric(
                        &telemetry,
                        "ssh_proxy_connections_total",
                        vec![("result", "rejected_paused".to_string())],
                        1.0,
                    );
                }
            }
        });
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
