use crate::config::{REQUEST_HEADER_DEADLINE, REQUEST_LIFETIME_DEADLINE, TLS_HANDSHAKE_DEADLINE};
use crate::request::{find_header_end, read_request_head, request_plan, RequestMode};
use crate::runtime::{ActiveConnectionGuard, Runtime};
use crate::snapshot::{RouteAuthorization, SnapshotCertResolver, SnapshotStore};
use crate::upstream::proxy_request;
use anyhow::{anyhow, Context, Result};
use std::net::SocketAddr;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{watch, Semaphore};
use tokio::time;
use tokio_rustls::TlsAcceptor;
use tracing::{debug, info};

pub(crate) async fn http_listener(
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

pub(crate) async fn accept_tls_with_deadline<S>(
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

pub(crate) async fn handle_connection<S>(
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

pub(crate) async fn handle_connection_with_fixed_request_deadline<S>(
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

pub(crate) async fn wait_until_route_revoked(
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

pub(crate) async fn reject<S: AsyncWrite + Unpin>(
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

#[cfg(test)]
#[path = "listener_tests.rs"]
mod tests;
