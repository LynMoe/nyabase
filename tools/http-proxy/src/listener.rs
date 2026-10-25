use crate::config::{REQUEST_HEADER_DEADLINE, TLS_HANDSHAKE_DEADLINE};
use crate::container_limit::UpstreamRefusal;
use crate::relay::{client_abort, is_client_abort, write_client_with_deadline};
use crate::request::{
    find_header_end, read_request_head, request_plan, ClientContext, RequestMode,
};
use crate::runtime::{ActiveConnectionGuard, Runtime};
use crate::snapshot::{Route, RouteAuthorization, SnapshotCertResolver, SnapshotStore};
use crate::upstream::proxy_request;
use anyhow::{anyhow, Context, Result};
use proxy_common::accept::accept_retrying;
use proxy_common::conn_limit::{wait_evicted, ConnectionLimiter, PendingEviction, PendingPermit};
use std::future::Future;
use std::net::SocketAddr;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio::time;
use tokio_rustls::TlsAcceptor;
use tracing::{debug, info, warn};

pub(crate) async fn http_listener(
    listen: String,
    store: Arc<SnapshotStore>,
    runtime: Arc<Runtime>,
    connection_slots: Arc<ConnectionLimiter>,
    tls: bool,
) -> Result<()> {
    let listener = TcpListener::bind(&listen).await?;
    info!(listen, tls, "HTTP proxy listener ready");
    serve_http(listener, store, runtime, connection_slots, tls).await
}

pub(crate) async fn serve_http(
    listener: TcpListener,
    store: Arc<SnapshotStore>,
    runtime: Arc<Runtime>,
    connection_slots: Arc<ConnectionLimiter>,
    tls: bool,
) -> Result<()> {
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
        let (stream, peer) = accept_retrying(
            || listener.accept(),
            |error, delay| {
                warn!(%error, retry_ms = delay.as_millis() as u64, "HTTP proxy accept failed");
            },
        )
        .await;
        // Admission happens before TLS or any read, and the permit lives
        // until the connection (or its upgraded tunnel) ends.
        let mut permit = match connection_slots.try_acquire(peer.ip()) {
            Ok(permit) => permit,
            Err(limit) => {
                runtime
                    .total_rejected_requests
                    .fetch_add(1, Ordering::Relaxed);
                debug!(%peer, limit = limit.as_str(), "HTTP proxy connection limit reached");
                drop(stream);
                continue;
            }
        };
        let store = store.clone();
        let runtime = runtime.clone();
        let acceptor = acceptor.clone();
        tokio::spawn(async move {
            // The pending slot covers the TLS handshake and the request head.
            let pending = permit.take_pending();
            let eviction = pending.as_ref().map(PendingPermit::eviction);
            let _active = ActiveConnectionGuard::new(runtime.clone(), permit);
            let accepted = Accepted {
                peer,
                https: acceptor.is_some(),
                pending,
            };
            let result = if let Some(acceptor) = acceptor {
                let handshake = accept_tls_with_deadline(&acceptor, stream, TLS_HANDSHAKE_DEADLINE);
                match unless_evicted(eviction.as_ref(), handshake).await {
                    Ok(mut tls_stream) => {
                        let result =
                            handle_accepted(&mut tls_stream, accepted, store, runtime.clone())
                                .await;
                        reset_if_aborted(&result, tls_stream.get_ref().0);
                        result
                    }
                    Err(error) => Err(anyhow!(error)),
                }
            } else {
                let mut stream = stream;
                let result = handle_accepted(&mut stream, accepted, store, runtime.clone()).await;
                reset_if_aborted(&result, &stream);
                result
            };
            if let Err(error) = result {
                debug!(%peer, %error, "request handling failed");
            }
        });
    }
}

/// SO_LINGER 0 makes the close that follows send RST, so a client whose
/// response was cut short sees an error instead of a clean end of body.
fn reset_if_aborted(result: &Result<()>, stream: &TcpStream) {
    if let Err(error) = result {
        if is_client_abort(error) {
            let _ = stream.set_zero_linger();
        }
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

/// Runs `work` (the TLS handshake, reading the request head) unless the
/// connection's pending slot is evicted for a lighter client first.
pub(crate) async fn unless_evicted<T>(
    eviction: Option<&PendingEviction>,
    work: impl Future<Output = Result<T>>,
) -> Result<T> {
    tokio::select! {
        biased;
        _ = wait_evicted(eviction) => {
            Err(anyhow!("pending connection evicted to admit a lighter client"))
        }
        result = work => result,
    }
}

/// One accepted client connection.
pub(crate) struct Accepted {
    pub(crate) peer: SocketAddr,
    pub(crate) https: bool,
    /// Pre-header slot, released once the request head has been read.
    pub(crate) pending: Option<PendingPermit>,
}

#[cfg(test)]
pub(crate) async fn handle_connection<S>(
    mut inbound: S,
    peer: SocketAddr,
    store: Arc<SnapshotStore>,
    runtime: Arc<Runtime>,
) -> Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let accepted = Accepted {
        peer,
        https: false,
        pending: None,
    };
    handle_accepted(&mut inbound, accepted, store, runtime).await
}

pub(crate) async fn handle_accepted<S>(
    inbound: &mut S,
    accepted: Accepted,
    store: Arc<SnapshotStore>,
    runtime: Arc<Runtime>,
) -> Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    runtime.total_requests.fetch_add(1, Ordering::Relaxed);
    let eviction = accepted.pending.as_ref().map(PendingPermit::eviction);
    let read_head = async {
        match time::timeout(REQUEST_HEADER_DEADLINE, read_request_head(&mut *inbound)).await {
            Ok(result) => result,
            Err(_) => Err(anyhow!("request header deadline exceeded")),
        }
    };
    let head = unless_evicted(eviction.as_ref(), read_head).await?;
    drop(accepted.pending);
    let Some(header_end) = find_header_end(&head) else {
        return Err(anyhow!("request header terminator is missing"));
    };
    let client = ClientContext {
        peer_ip: accepted.peer.ip(),
        https: accepted.https,
    };
    let plan = match request_plan(&head[..header_end], &client) {
        Ok(plan) => plan,
        Err(error) => {
            reject(inbound, &runtime, "400 Bad Request").await?;
            return Err(error);
        }
    };
    let host = plan.host.clone();
    let mut changes = store.subscribe();
    let Some(authorization) = store.authorize_route(&host) else {
        reject(inbound, &runtime, "404 Not Found").await?;
        return Ok(());
    };
    if !store.authorization_is_current(&authorization) {
        reject(inbound, &runtime, "404 Not Found").await?;
        return Ok(());
    }
    // Held until this function returns, whichever way, so the slots cover
    // the whole exchange or upgraded tunnel.
    let route = &authorization.route;
    let counters = runtime.binding_stats.counters(&route.binding_id);
    counters.count_request();
    let _container_slot = match runtime.container_slots.try_acquire(
        accepted.peer.ip(),
        &route.container_id,
        &route.owner_id,
    ) {
        Ok(permit) => permit,
        Err(refusal) => {
            note_upstream_refusal(&runtime, route, &host, refusal);
            reject(inbound, &runtime, "503 Service Unavailable").await?;
            return Ok(());
        }
    };

    let is_websocket = matches!(&plan.mode, RequestMode::WebSocket { .. });
    let _active_relay = counters.open_relay();
    // An upgraded tunnel has no total lifetime, only its own idle timeout
    // (and the per-container cap); an ordinary request is bounded by the body
    // deadline, the request idle timeout and the response lifetime (all
    // inside `proxy_request`). Both end at once when the route lease lapses
    // or the route is revoked.
    let proxy = proxy_request(
        inbound,
        &runtime,
        &authorization.route,
        head,
        header_end,
        plan,
    );
    tokio::select! {
        biased;
        _ = wait_until_route_revoked(&store, &authorization, &mut changes) => {
            return Err(client_abort("HTTP route authorization was revoked"));
        }
        result = proxy => result?,
    }
    debug!(
        binding_id = %authorization.route.binding_id,
        hostname = %host,
        is_websocket,
        "proxied request"
    );
    Ok(())
}

/// Operators need to see which container or owner is saturated, but a flood
/// of refusals must not flood the log: one warning per container (or owner)
/// per interval, carrying the count it stands for. One client over its share
/// of a container is only a debug line.
fn note_upstream_refusal(runtime: &Runtime, route: &Route, host: &str, refusal: UpstreamRefusal) {
    let caps = runtime.container_slots.caps();
    let (id, limit) = match refusal {
        UpstreamRefusal::Container => (&route.container_id, caps.per_container),
        UpstreamRefusal::ClientPerContainer => (&route.container_id, caps.per_client_per_container),
        UpstreamRefusal::Owner => (&route.owner_id, caps.per_owner),
    };
    match runtime
        .container_slots
        .note_refusal(refusal, id, Instant::now())
    {
        Some(refused) => warn!(
            container_id = %route.container_id,
            owner_id = %route.owner_id,
            binding_id = %route.binding_id,
            hostname = %host,
            cap = refusal.as_str(),
            limit,
            refused,
            "HTTP proxy upstream connection limit reached; refusing with 503"
        ),
        None => debug!(
            container_id = %route.container_id,
            hostname = %host,
            cap = refusal.as_str(),
            "HTTP proxy upstream connection limit reached"
        ),
    }
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
    let response = format!("HTTP/1.1 {status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    write_client_with_deadline(runtime.limits.client_write, "rejection", async {
        inbound.write_all(response.as_bytes()).await?;
        inbound.shutdown().await
    })
    .await
}

#[cfg(test)]
#[path = "listener_tests.rs"]
mod tests;
