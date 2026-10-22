use anyhow::{anyhow, Result};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::io::{self, AsyncRead, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::time::{self, Instant};

/// Relays an upgraded connection until either side closes, or until no byte
/// has moved in either direction for `idle`. Without the idle bound a parked
/// tunnel would hold its connection slot (and two sockets) forever.
pub(crate) async fn relay_with_idle_timeout<A, B>(
    a: &mut A,
    b: &mut B,
    idle: Duration,
) -> Result<()>
where
    A: AsyncRead + AsyncWrite + Unpin,
    B: AsyncRead + AsyncWrite + Unpin,
{
    {
        let activity = Activity::new();
        let mut tracked_a = Tracked {
            inner: &mut *a,
            activity: &activity,
        };
        let mut tracked_b = Tracked {
            inner: &mut *b,
            activity: &activity,
        };
        let relay = io::copy_bidirectional(&mut tracked_a, &mut tracked_b);
        tokio::pin!(relay);
        loop {
            tokio::select! {
                result = &mut relay => {
                    result?;
                    break;
                }
                _ = time::sleep_until(activity.last() + idle) => {
                    if activity.last() + idle <= Instant::now() {
                        return Err(anyhow!("upgraded connection idle timeout exceeded"));
                    }
                }
            }
        }
    }
    a.shutdown().await?;
    b.shutdown().await?;
    Ok(())
}

struct Activity {
    base: Instant,
    last_ms: AtomicU64,
}

impl Activity {
    fn new() -> Self {
        Self {
            base: Instant::now(),
            last_ms: AtomicU64::new(0),
        }
    }

    fn touch(&self) {
        self.last_ms
            .store(self.base.elapsed().as_millis() as u64, Ordering::Relaxed);
    }

    fn last(&self) -> Instant {
        self.base + Duration::from_millis(self.last_ms.load(Ordering::Relaxed))
    }
}

/// Marks the shared activity clock whenever bytes are read from `inner`;
/// every relayed byte is read from one side, so this covers both directions.
struct Tracked<'a, T> {
    inner: &'a mut T,
    activity: &'a Activity,
}

impl<T: AsyncRead + Unpin> AsyncRead for Tracked<'_, T> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = buf.filled().len();
        let result = Pin::new(&mut *self.inner).poll_read(cx, buf);
        if matches!(result, Poll::Ready(Ok(()))) && buf.filled().len() > before {
            self.activity.touch();
        }
        result
    }
}

impl<T: AsyncWrite + Unpin> AsyncWrite for Tracked<'_, T> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut *self.inner).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut *self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut *self.inner).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    #[tokio::test]
    async fn traffic_in_either_direction_keeps_the_tunnel_open_and_silence_closes_it() {
        let (mut client, mut proxy_client_side) = tokio::io::duplex(1024);
        let (mut proxy_upstream_side, mut upstream) = tokio::io::duplex(1024);
        let idle = Duration::from_millis(150);
        let relay = tokio::spawn(async move {
            relay_with_idle_timeout(&mut proxy_client_side, &mut proxy_upstream_side, idle).await
        });

        // Alternate directions, each gap shorter than the idle bound but the
        // total far longer than it.
        let mut byte = [0_u8; 1];
        for round in 0..8 {
            time::sleep(Duration::from_millis(60)).await;
            if round % 2 == 0 {
                client.write_all(b"c").await.unwrap();
                upstream.read_exact(&mut byte).await.unwrap();
                assert_eq!(&byte, b"c");
            } else {
                upstream.write_all(b"u").await.unwrap();
                client.read_exact(&mut byte).await.unwrap();
                assert_eq!(&byte, b"u");
            }
        }
        assert!(!relay.is_finished(), "active tunnel hit the idle timeout");

        let result = time::timeout(Duration::from_secs(2), relay)
            .await
            .expect("idle tunnel was not closed")
            .unwrap();
        assert!(result.unwrap_err().to_string().contains("idle timeout"));
        assert_eq!(client.read(&mut byte).await.unwrap(), 0);
        assert_eq!(upstream.read(&mut byte).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn a_clean_close_ends_the_relay_without_error() {
        let (mut client, mut proxy_client_side) = tokio::io::duplex(1024);
        let (mut proxy_upstream_side, mut upstream) = tokio::io::duplex(1024);
        let relay = tokio::spawn(async move {
            relay_with_idle_timeout(
                &mut proxy_client_side,
                &mut proxy_upstream_side,
                Duration::from_secs(60),
            )
            .await
        });
        client.write_all(b"ping").await.unwrap();
        client.shutdown().await.unwrap();
        let mut received = Vec::new();
        upstream.read_to_end(&mut received).await.unwrap();
        assert_eq!(received, b"ping");
        upstream.shutdown().await.unwrap();
        time::timeout(Duration::from_secs(1), relay)
            .await
            .expect("relay did not finish")
            .unwrap()
            .unwrap();
    }
}
