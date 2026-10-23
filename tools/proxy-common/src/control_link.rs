//! Liveness of the proxy → Backend control WebSocket.
//!
//! Without deadlines a Backend that vanished without closing the socket (host
//! power loss, a dropped NAT entry, a silently partitioned network) left the
//! proxy "connected" until TCP gave up, up to about 15 minutes: no reconnect,
//! no hold timer, and a stuck connect or TLS handshake blocked the reconnect
//! loop the same way. So the connect (TCP, TLS and the WebSocket upgrade) has
//! a deadline, the proxy pings the Backend on a fixed interval, and a link
//! that delivers no frame at all (the Backend's pongs and its own pings
//! included) within the read deadline is treated as dead and dropped, which
//! starts the hold window and the reconnect loop.

use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use tokio::net::TcpStream;
use tokio::time::{self, Instant};
use tokio_tungstenite::tungstenite::handshake::client::Request;
use tokio_tungstenite::{
    connect_async_tls_with_config, Connector, MaybeTlsStream, WebSocketStream,
};

pub const CONTROL_CONNECT_DEADLINE: Duration = Duration::from_secs(10);

pub const CONTROL_PING_INTERVAL: Duration = Duration::from_secs(15);

/// Three ping intervals: one lost pong is not enough to drop the link.
pub const CONTROL_READ_DEADLINE: Duration = Duration::from_secs(45);

pub type ControlStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ControlLiveness {
    /// TCP connect, TLS handshake and WebSocket upgrade together.
    pub connect_deadline: Duration,
    /// How often the proxy sends a WebSocket ping.
    pub ping_interval: Duration,
    /// The link is dead when no frame arrives for this long.
    pub read_deadline: Duration,
}

impl Default for ControlLiveness {
    fn default() -> Self {
        Self {
            connect_deadline: CONTROL_CONNECT_DEADLINE,
            ping_interval: CONTROL_PING_INTERVAL,
            read_deadline: CONTROL_READ_DEADLINE,
        }
    }
}

impl ControlLiveness {
    /// The first ping fires one interval after the link comes up.
    pub fn ping_timer(&self) -> time::Interval {
        let mut timer = time::interval_at(Instant::now() + self.ping_interval, self.ping_interval);
        timer.set_missed_tick_behavior(time::MissedTickBehavior::Delay);
        timer
    }

    /// When the link is dead if nothing arrives after `last_frame`.
    pub fn read_deadline_after(&self, last_frame: Instant) -> Instant {
        last_frame + self.read_deadline
    }

    pub fn dead_link_error(&self, proxy: &str) -> anyhow::Error {
        anyhow!(
            "{proxy} control link delivered no frame for {} ms; treating the Backend as gone",
            self.read_deadline.as_millis()
        )
    }
}

/// Connects the control WebSocket within `deadline`.
pub async fn connect_control(
    request: Request,
    connector: Option<Connector>,
    deadline: Duration,
) -> Result<ControlStream> {
    match time::timeout(
        deadline,
        connect_async_tls_with_config(request, None, false, connector),
    )
    .await
    {
        Ok(result) => Ok(result.context("control WebSocket connect failed")?.0),
        Err(_) => Err(anyhow!(
            "control WebSocket connect, TLS handshake or upgrade took longer than {} ms",
            deadline.as_millis()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    #[tokio::test]
    async fn a_backend_that_never_completes_the_upgrade_hits_the_connect_deadline() {
        // Accepts TCP but never answers the HTTP upgrade.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let silent = tokio::spawn(async move {
            let (_socket, _) = listener.accept().await.unwrap();
            std::future::pending::<()>().await;
        });
        let request = format!("ws://{address}/ws/test")
            .into_client_request()
            .unwrap();
        let error = connect_control(request, None, Duration::from_millis(50))
            .await
            .unwrap_err();
        assert!(
            error.to_string().contains("took longer than 50 ms"),
            "{error}"
        );
        silent.abort();
    }

    #[test]
    fn the_read_deadline_outlasts_more_than_one_ping_interval() {
        let liveness = ControlLiveness::default();
        assert!(liveness.read_deadline >= liveness.ping_interval * 2);
        assert!(liveness.connect_deadline < liveness.read_deadline);
    }
}
