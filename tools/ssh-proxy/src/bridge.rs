use crate::protocol::{ProxyEvent, SshProxyAuditEvent, SshProxyMetric, TelemetrySender};
use crate::runtime::{ChildTaskPermit, ConnectionState};
use anyhow::Result;
use proxy_common::clock::now_ms;
use russh::server::Msg as ServerMsg;
use russh::Channel;
#[cfg(test)]
use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context as PollContext, Poll};
use tokio::io::{self, AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;
use tracing::debug;

pub(crate) fn emit_metric(
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

pub(crate) fn emit_audit(telemetry: &TelemetrySender, event: SshProxyAuditEvent) {
    if telemetry.try_send(ProxyEvent::Audit(event)).is_err() {
        debug!("SSH proxy telemetry audit event dropped");
    }
}

#[cfg(test)]
pub(crate) fn spawn_connection_task<F>(connection: Arc<ConnectionState>, future: F)
where
    F: Future<Output = ()> + Send + 'static,
{
    let Some(permit) = connection.try_reserve_child_task() else {
        return;
    };
    permit.spawn(future);
}

/// Counts bytes as they flow so live status reports non-zero traffic mid-session.
/// When wrapping the SSH channel side of a direct-tcpip bridge:
/// - reads  = client → target (`bytes_from_client`)
/// - writes = target → client (`bytes_to_client`)
pub(crate) struct MeteredChannelStream<S> {
    pub(crate) inner: S,
    pub(crate) connection: Arc<ConnectionState>,
}

impl<S> MeteredChannelStream<S> {
    pub(crate) fn new(inner: S, connection: Arc<ConnectionState>) -> Self {
        Self { inner, connection }
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for MeteredChannelStream<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut PollContext<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let before = buf.filled().len();
        let result = Pin::new(&mut self.inner).poll_read(cx, buf);
        if let Poll::Ready(Ok(())) = &result {
            let n = buf.filled().len().saturating_sub(before);
            if n > 0 {
                self.connection.record_from_client(n);
            }
        }
        result
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for MeteredChannelStream<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut PollContext<'_>,
        buf: &[u8],
    ) -> Poll<Result<usize, std::io::Error>> {
        match Pin::new(&mut self.inner).poll_write(cx, buf) {
            Poll::Ready(Ok(n)) => {
                if n > 0 {
                    self.connection.record_to_client(n);
                }
                Poll::Ready(Ok(n))
            }
            other => other,
        }
    }

    fn poll_flush(
        mut self: Pin<&mut Self>,
        cx: &mut PollContext<'_>,
    ) -> Poll<Result<(), std::io::Error>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(
        mut self: Pin<&mut Self>,
        cx: &mut PollContext<'_>,
    ) -> Poll<Result<(), std::io::Error>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

pub(crate) fn spawn_tcp_bridge(
    permit: ChildTaskPermit,
    peer: SocketAddr,
    channel: Channel<ServerMsg>,
    stream: TcpStream,
    connection: Arc<ConnectionState>,
) {
    // The guard lives in the future, so the channel count is released even
    // when the bridge is aborted (route revoked) before or while it runs.
    let open_channel = OpenChannel::new(connection.clone());
    permit.spawn(async move {
        let _open_channel = open_channel;
        let mut channel_stream = MeteredChannelStream::new(channel.into_stream(), connection);
        let mut tcp_stream = stream;
        if let Err(error) = io::copy_bidirectional(&mut channel_stream, &mut tcp_stream).await {
            debug!(%peer, %error, "SSH direct-tcpip bridge ended with error");
        }
    });
}

pub(crate) struct OpenChannel(Arc<ConnectionState>);

impl OpenChannel {
    pub(crate) fn new(connection: Arc<ConnectionState>) -> Self {
        connection.channel_opened();
        Self(connection)
    }
}

impl Drop for OpenChannel {
    fn drop(&mut self) {
        self.0.channel_closed();
    }
}

#[cfg(test)]
#[path = "bridge_tests.rs"]
mod tests;
