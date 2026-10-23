use crate::container_limit::UpstreamCaps;
use anyhow::{anyhow, Result};
use proxy_common::backend_tls::{backend_tls_config_from_env, validate_backend_ws_url};
use proxy_common::conn_limit::{validate_limit, LimitSettings};
use proxy_common::control_link::ControlLiveness;
use proxy_common::control_token::required_control_token;
use proxy_common::env::{env_u64, env_usize, validate_status_interval_ms};
use std::sync::Arc;
use std::time::Duration;

pub(crate) const MAX_REQUEST_HEADER_BYTES: usize = 64 * 1024;

pub(crate) const MAX_UPSTREAM_UPGRADE_HEADER_BYTES: usize = 64 * 1024;

pub(crate) const MAX_REQUEST_BODY_BYTES: usize = 16 * 1024 * 1024;

/// Longest chunk-size line (size plus extensions) in a chunked request body.
pub(crate) const MAX_CHUNK_LINE_BYTES: usize = 4 * 1024;

/// Total size of the (discarded) trailer section of a chunked request body.
pub(crate) const MAX_CHUNK_TRAILER_BYTES: usize = 8 * 1024;

pub(crate) const REQUEST_HEADER_DEADLINE: Duration = Duration::from_secs(10);

pub(crate) const UPSTREAM_CONNECT_DEADLINE: Duration = Duration::from_secs(10);

pub(crate) const UPSTREAM_UPGRADE_HEADER_DEADLINE: Duration = Duration::from_secs(10);

pub(crate) const CONTROL_WRITE_DEADLINE: Duration = Duration::from_secs(5);

pub(crate) const TLS_HANDSHAKE_DEADLINE: Duration = Duration::from_secs(10);

/// One proxy-generated write to the client that no idle or lifetime timer
/// covers (an error response, `100 Continue`, the WebSocket handshake, the
/// final shutdown with its TLS close_notify).
pub(crate) const CLIENT_WRITE_DEADLINE: Duration = Duration::from_secs(10);

pub(crate) const MAX_SNAPSHOT_STALE_AFTER_MS: u64 = 300_000;

// Request bodies are streamed to the upstream rather than buffered, so a
// connection costs bounded memory (header buffer + copy buffers) and the cap
// is about file descriptors, not resident set. Each proxied connection holds
// two sockets; size the service's open-file limit accordingly.
pub(crate) const MAX_CONNECTIONS_LIMIT: usize = 65_536;

pub(crate) const DEFAULT_MAX_CONNECTIONS: usize = 4_096;

pub(crate) const DEFAULT_MAX_CONNECTIONS_PER_IP: usize = 64;

pub(crate) const DEFAULT_MAX_CONNECTIONS_PER_IPV6_48: usize = 256;

/// Concurrent connections to one upstream container (all its hostnames
/// together), an eighth of the default pool, so a single site cannot hold
/// every slot with long-lived tunnels or slow responses.
pub(crate) const DEFAULT_MAX_CONNECTIONS_PER_CONTAINER: usize = 512;

/// Concurrent connections from one client (IPv4 address / IPv6 /64) to one
/// container: a sixteenth of the per-container cap, so a few clients
/// dripping bodies or holding WebSocket upgrades cannot fill a container and
/// lock its other visitors out. Ample for one browser (each connection
/// carries one request).
pub(crate) const DEFAULT_MAX_CONNECTIONS_PER_IP_PER_CONTAINER: usize = 32;

/// Concurrent connections to all of one owner's containers together, a
/// quarter of the default pool, so one tenant with many containers cannot
/// hold every slot.
pub(crate) const DEFAULT_MAX_CONNECTIONS_PER_OWNER: usize = 1_024;

/// Connections still in the TLS handshake or sending their request head; a
/// quarter of the default pool. A source may use its whole per-IP total of
/// it while there is room; a full pool admits a fresh source by evicting the
/// heaviest source's oldest pending connection.
pub(crate) const DEFAULT_MAX_PENDING_CONNECTIONS: usize = 1_024;

pub(crate) const DEFAULT_BODY_DEADLINE_MS: u64 = 30_000;

pub(crate) const MIN_BODY_DEADLINE_MS: u64 = 1_000;

pub(crate) const MAX_BODY_DEADLINE_MS: u64 = 3_600_000;

pub(crate) const DEFAULT_IDLE_TIMEOUT_MS: u64 = 120_000;

pub(crate) const MIN_IDLE_TIMEOUT_MS: u64 = 1_000;

pub(crate) const MAX_IDLE_TIMEOUT_MS: u64 = 86_400_000;

pub(crate) const DEFAULT_RESPONSE_LIFETIME_MS: u64 = 1_800_000;

pub(crate) const MIN_RESPONSE_LIFETIME_MS: u64 = 1_000;

pub(crate) const MAX_RESPONSE_LIFETIME_MS: u64 = 86_400_000;

pub(crate) const DEFAULT_UPGRADED_IDLE_MS: u64 = 3_600_000;

pub(crate) const MIN_UPGRADED_IDLE_MS: u64 = 1_000;

pub(crate) const MAX_UPGRADED_IDLE_MS: u64 = 86_400_000;

pub(crate) const DEFAULT_CONTROL_HOLD_MS: u64 = 300_000;

pub(crate) const MAX_CONTROL_HOLD_MS: u64 = 600_000;

/// Per-connection timing limits that the listener and relays consult.
#[derive(Clone, Copy, Debug)]
pub(crate) struct ConnectionLimits {
    /// Whole-body budget, measured from the end of the request head.
    pub(crate) body_deadline: Duration,
    /// An ordinary request is closed after this long with no bytes moving in
    /// either direction (waiting for the upstream's answer included).
    pub(crate) idle: Duration,
    /// Total time for an ordinary request's response, measured from the end
    /// of the request body, so a drip-fed response cannot hold its slot
    /// forever. Generous enough for long downloads, SSE and long-poll;
    /// upgraded tunnels have no total lifetime.
    pub(crate) response_lifetime: Duration,
    /// An upgraded tunnel with no bytes in either direction for this long is closed.
    pub(crate) upgraded_idle: Duration,
    /// `CLIENT_WRITE_DEADLINE`; a field only so tests can shorten it.
    pub(crate) client_write: Duration,
}

impl Default for ConnectionLimits {
    fn default() -> Self {
        Self {
            body_deadline: Duration::from_millis(DEFAULT_BODY_DEADLINE_MS),
            idle: Duration::from_millis(DEFAULT_IDLE_TIMEOUT_MS),
            response_lifetime: Duration::from_millis(DEFAULT_RESPONSE_LIFETIME_MS),
            upgraded_idle: Duration::from_millis(DEFAULT_UPGRADED_IDLE_MS),
            client_write: CLIENT_WRITE_DEADLINE,
        }
    }
}

#[derive(Clone)]
pub(crate) struct Config {
    pub(crate) backend_ws: String,
    pub(crate) backend_tls: Option<Arc<rustls::ClientConfig>>,
    pub(crate) token: String,
    pub(crate) http_listen: String,
    pub(crate) https_listen: Option<String>,
    pub(crate) max_connections: usize,
    pub(crate) max_connections_per_ip: usize,
    pub(crate) max_connections_per_ipv6_48: usize,
    pub(crate) max_pending_connections: usize,
    pub(crate) max_connections_per_container: usize,
    pub(crate) max_connections_per_ip_per_container: usize,
    pub(crate) max_connections_per_owner: usize,
    pub(crate) limits: ConnectionLimits,
    pub(crate) reconnect_delay: Duration,
    pub(crate) status_interval: Duration,
    pub(crate) control_hold: Duration,
    pub(crate) control_liveness: ControlLiveness,
}

impl Config {
    pub(crate) fn from_env() -> Result<Self> {
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
        let max_connections = validate_limit(
            "NYABASE_HTTP_MAX_CONNECTIONS",
            env_usize("NYABASE_HTTP_MAX_CONNECTIONS", DEFAULT_MAX_CONNECTIONS)?,
            1,
            MAX_CONNECTIONS_LIMIT,
        )?;
        let max_connections_per_ip = validate_limit(
            "NYABASE_HTTP_MAX_CONNECTIONS_PER_IP",
            env_usize(
                "NYABASE_HTTP_MAX_CONNECTIONS_PER_IP",
                DEFAULT_MAX_CONNECTIONS_PER_IP,
            )?,
            1,
            MAX_CONNECTIONS_LIMIT,
        )?;
        let max_connections_per_ipv6_48 = validate_limit(
            "NYABASE_HTTP_MAX_CONNECTIONS_PER_IPV6_48",
            env_usize(
                "NYABASE_HTTP_MAX_CONNECTIONS_PER_IPV6_48",
                DEFAULT_MAX_CONNECTIONS_PER_IPV6_48,
            )?,
            1,
            MAX_CONNECTIONS_LIMIT,
        )?;
        let max_pending_connections = validate_limit(
            "NYABASE_HTTP_MAX_PENDING_CONNECTIONS",
            env_usize(
                "NYABASE_HTTP_MAX_PENDING_CONNECTIONS",
                DEFAULT_MAX_PENDING_CONNECTIONS.min(max_connections),
            )?,
            1,
            max_connections,
        )?;
        let max_connections_per_container = validate_limit(
            "NYABASE_HTTP_MAX_CONNECTIONS_PER_CONTAINER",
            env_usize(
                "NYABASE_HTTP_MAX_CONNECTIONS_PER_CONTAINER",
                DEFAULT_MAX_CONNECTIONS_PER_CONTAINER.min(max_connections),
            )?,
            1,
            max_connections,
        )?;
        let per_ip_per_container_cap = max_connections_per_ip.min(max_connections_per_container);
        let max_connections_per_ip_per_container = validate_limit(
            "NYABASE_HTTP_MAX_CONNECTIONS_PER_IP_PER_CONTAINER",
            env_usize(
                "NYABASE_HTTP_MAX_CONNECTIONS_PER_IP_PER_CONTAINER",
                DEFAULT_MAX_CONNECTIONS_PER_IP_PER_CONTAINER.min(per_ip_per_container_cap),
            )?,
            1,
            per_ip_per_container_cap,
        )?;
        let max_connections_per_owner = validate_limit(
            "NYABASE_HTTP_MAX_CONNECTIONS_PER_OWNER",
            env_usize(
                "NYABASE_HTTP_MAX_CONNECTIONS_PER_OWNER",
                DEFAULT_MAX_CONNECTIONS_PER_OWNER
                    .max(max_connections_per_container)
                    .min(max_connections),
            )?,
            max_connections_per_container,
            max_connections,
        )?;
        let limits = ConnectionLimits {
            body_deadline: Duration::from_millis(validate_ms(
                "NYABASE_HTTP_BODY_DEADLINE_MS",
                env_u64("NYABASE_HTTP_BODY_DEADLINE_MS", DEFAULT_BODY_DEADLINE_MS)?,
                MIN_BODY_DEADLINE_MS,
                MAX_BODY_DEADLINE_MS,
            )?),
            idle: Duration::from_millis(validate_ms(
                "NYABASE_HTTP_IDLE_TIMEOUT_MS",
                env_u64("NYABASE_HTTP_IDLE_TIMEOUT_MS", DEFAULT_IDLE_TIMEOUT_MS)?,
                MIN_IDLE_TIMEOUT_MS,
                MAX_IDLE_TIMEOUT_MS,
            )?),
            response_lifetime: Duration::from_millis(validate_ms(
                "NYABASE_HTTP_RESPONSE_LIFETIME_MS",
                env_u64(
                    "NYABASE_HTTP_RESPONSE_LIFETIME_MS",
                    DEFAULT_RESPONSE_LIFETIME_MS,
                )?,
                MIN_RESPONSE_LIFETIME_MS,
                MAX_RESPONSE_LIFETIME_MS,
            )?),
            upgraded_idle: Duration::from_millis(validate_ms(
                "NYABASE_HTTP_UPGRADED_IDLE_MS",
                env_u64("NYABASE_HTTP_UPGRADED_IDLE_MS", DEFAULT_UPGRADED_IDLE_MS)?,
                MIN_UPGRADED_IDLE_MS,
                MAX_UPGRADED_IDLE_MS,
            )?),
            client_write: CLIENT_WRITE_DEADLINE,
        };
        let control_hold = Duration::from_millis(validate_ms(
            "NYABASE_HTTP_CONTROL_HOLD_MS",
            env_u64("NYABASE_HTTP_CONTROL_HOLD_MS", DEFAULT_CONTROL_HOLD_MS)?,
            0,
            MAX_CONTROL_HOLD_MS,
        )?);
        let reconnect_delay =
            Duration::from_millis(env_u64("NYABASE_BACKEND_RECONNECT_MS", 2_000)?);
        let status_interval = Duration::from_millis(validate_status_interval_ms(
            "NYABASE_HTTP_STATUS_INTERVAL_MS",
            env_u64("NYABASE_HTTP_STATUS_INTERVAL_MS", 1_000)?,
        )?);
        Ok(Self {
            backend_ws,
            backend_tls,
            token,
            http_listen,
            https_listen,
            max_connections,
            max_connections_per_ip,
            max_connections_per_ipv6_48,
            max_pending_connections,
            max_connections_per_container,
            max_connections_per_ip_per_container,
            max_connections_per_owner,
            limits,
            reconnect_delay,
            status_interval,
            control_hold,
            control_liveness: ControlLiveness::default(),
        })
    }
}

impl Config {
    pub(crate) fn upstream_caps(&self) -> UpstreamCaps {
        UpstreamCaps {
            per_container: self.max_connections_per_container,
            per_client_per_container: self.max_connections_per_ip_per_container,
            per_owner: self.max_connections_per_owner,
        }
    }

    pub(crate) fn connection_limits(&self) -> LimitSettings {
        LimitSettings {
            global: self.max_connections,
            per_client: self.max_connections_per_ip,
            per_site: self.max_connections_per_ipv6_48,
            pending: self.max_pending_connections,
        }
    }
}

pub(crate) fn validate_ms(name: &str, value: u64, min: u64, max: u64) -> Result<u64> {
    if !(min..=max).contains(&value) {
        return Err(anyhow!("{name} must be in {min}..={max}"));
    }
    Ok(value)
}

#[cfg(test)]
#[path = "config_tests.rs"]
mod tests;
