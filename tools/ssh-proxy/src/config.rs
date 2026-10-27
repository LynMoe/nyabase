use anyhow::Result;
use proxy_common::backend_tls::{backend_tls_config_from_env, validate_backend_ws_url};
use proxy_common::conn_limit::{validate_limit, LimitSettings};
use proxy_common::control_link::ControlLiveness;
use proxy_common::control_token::required_control_token;
use proxy_common::env::{env_u64, env_usize, validate_status_interval_ms};

use crate::proxy_protocol::TrustedSources;
use std::sync::Arc;
use std::time::Duration;

pub(crate) const SSH_PROXY_SNAPSHOT_STALE_MIN_MS: u64 = 120_000;

pub(crate) const SSH_PROXY_SNAPSHOT_STALE_MAX_MS: u64 = 300_000;

pub(crate) const MAX_PROXY_CONNECTIONS: usize = 1024;

pub(crate) const DEFAULT_MAX_CONNECTIONS_PER_IP: usize = 16;

pub(crate) const DEFAULT_MAX_CONNECTIONS_PER_IPV6_48: usize = 64;

/// Connections that have not authenticated yet; a quarter of the default pool.
/// A source may use its whole per-IP total of it while there is room; a full
/// pool admits a fresh source by evicting the heaviest source's oldest
/// unauthenticated connection.
pub(crate) const DEFAULT_MAX_PREAUTH_CONNECTIONS: usize = 128;

pub(crate) const DEFAULT_AUTH_TIMEOUT_MS: u64 = 30_000;

pub(crate) const MIN_AUTH_TIMEOUT_MS: u64 = 1_000;

pub(crate) const MAX_AUTH_TIMEOUT_MS: u64 = 600_000;

pub(crate) const SSH_PROXY_CONTROL_HOLD_MIN_MS: u64 = 180_000;

pub(crate) const SSH_PROXY_CONTROL_HOLD_MAX_MS: u64 = 600_000;

pub(crate) const SSH_PROXY_CONTROL_HOLD_DEFAULT_MS: u64 = 300_000;

pub(crate) fn valid_snapshot_stale_after_ms(value: u64) -> bool {
    (SSH_PROXY_SNAPSHOT_STALE_MIN_MS..=SSH_PROXY_SNAPSHOT_STALE_MAX_MS).contains(&value)
}

#[derive(Clone)]
pub(crate) struct ProxyConfig {
    pub(crate) backend_ws: String,
    pub(crate) backend_tls: Option<Arc<rustls::ClientConfig>>,
    pub(crate) token: String,
    pub(crate) listen: String,
    pub(crate) max_connections: usize,
    pub(crate) max_connections_per_ip: usize,
    pub(crate) max_connections_per_ipv6_48: usize,
    /// Accepted but not yet authenticated; bounded separately so pre-auth
    /// sockets cannot occupy the whole pool.
    pub(crate) max_preauth_connections: usize,
    /// From accept to successful public-key authentication.
    pub(crate) auth_timeout: Duration,
    pub(crate) reconnect_delay: Duration,
    pub(crate) route_connect_timeout: Duration,
    pub(crate) status_interval: Duration,
    pub(crate) control_hold: Duration,
    pub(crate) control_liveness: ControlLiveness,
    /// Peers whose PROXY header names the client (`proxy_protocol.rs`).
    pub(crate) proxy_protocol_trusted: TrustedSources,
}

impl ProxyConfig {
    pub(crate) fn from_env() -> Result<Self> {
        let backend_ws = std::env::var("NYABASE_BACKEND_WS")
            .unwrap_or_else(|_| "ws://127.0.0.1:3000/ws/ssh-proxy".to_string());
        let backend_tls = backend_tls_config_from_env("NYABASE_BACKEND_CA_FILE")?;
        validate_backend_ws_url(&backend_ws, backend_tls.is_some())?;
        let token = required_control_token("SSH_PROXY_TOKEN", "SSH_PROXY_TOKEN_FILE")?;
        let listen =
            std::env::var("NYABASE_SSH_LISTEN").unwrap_or_else(|_| "0.0.0.0:2222".to_string());
        let max_connections =
            validate_connection_cap(env_usize("NYABASE_SSH_MAX_CONNECTIONS", 512)?)?;
        let max_connections_per_ip = validate_limit(
            "NYABASE_SSH_MAX_CONNECTIONS_PER_IP",
            env_usize(
                "NYABASE_SSH_MAX_CONNECTIONS_PER_IP",
                DEFAULT_MAX_CONNECTIONS_PER_IP,
            )?,
            1,
            MAX_PROXY_CONNECTIONS,
        )?;
        let max_connections_per_ipv6_48 = validate_limit(
            "NYABASE_SSH_MAX_CONNECTIONS_PER_IPV6_48",
            env_usize(
                "NYABASE_SSH_MAX_CONNECTIONS_PER_IPV6_48",
                DEFAULT_MAX_CONNECTIONS_PER_IPV6_48,
            )?,
            1,
            MAX_PROXY_CONNECTIONS,
        )?;
        let max_preauth_connections = validate_limit(
            "NYABASE_SSH_MAX_PREAUTH_CONNECTIONS",
            env_usize(
                "NYABASE_SSH_MAX_PREAUTH_CONNECTIONS",
                DEFAULT_MAX_PREAUTH_CONNECTIONS.min(max_connections),
            )?,
            1,
            max_connections,
        )?;
        let auth_timeout_ms = validate_auth_timeout(env_u64(
            "NYABASE_SSH_AUTH_TIMEOUT_MS",
            DEFAULT_AUTH_TIMEOUT_MS,
        )?)?;
        let reconnect_delay_ms = env_u64("NYABASE_BACKEND_RECONNECT_MS", 2_000)?;
        let route_connect_timeout_ms = env_u64("NYABASE_SSH_ROUTE_CONNECT_TIMEOUT_MS", 10_000)?;
        let status_interval_ms = validate_status_interval_ms(
            "NYABASE_SSH_STATUS_INTERVAL_MS",
            env_u64("NYABASE_SSH_STATUS_INTERVAL_MS", 1_000)?,
        )?;
        let control_hold_ms = validate_control_hold(env_u64(
            "NYABASE_SSH_CONTROL_HOLD_MS",
            SSH_PROXY_CONTROL_HOLD_DEFAULT_MS,
        )?)?;

        Ok(Self {
            backend_ws,
            backend_tls,
            token,
            listen,
            max_connections,
            max_connections_per_ip,
            max_connections_per_ipv6_48,
            max_preauth_connections,
            auth_timeout: Duration::from_millis(auth_timeout_ms),
            reconnect_delay: Duration::from_millis(reconnect_delay_ms),
            route_connect_timeout: Duration::from_millis(route_connect_timeout_ms),
            status_interval: Duration::from_millis(status_interval_ms),
            control_hold: Duration::from_millis(control_hold_ms),
            control_liveness: ControlLiveness::default(),
            proxy_protocol_trusted: TrustedSources::from_env()?,
        })
    }
}

impl ProxyConfig {
    pub(crate) fn connection_limits(&self) -> LimitSettings {
        LimitSettings {
            global: self.max_connections,
            per_client: self.max_connections_per_ip,
            per_site: self.max_connections_per_ipv6_48,
            pending: self.max_preauth_connections,
        }
    }
}

pub(crate) fn validate_connection_cap(value: usize) -> Result<usize> {
    if !(1..=MAX_PROXY_CONNECTIONS).contains(&value) {
        anyhow::bail!("NYABASE_SSH_MAX_CONNECTIONS must be in 1..={MAX_PROXY_CONNECTIONS}");
    }
    Ok(value)
}

pub(crate) fn validate_auth_timeout(value: u64) -> Result<u64> {
    if !(MIN_AUTH_TIMEOUT_MS..=MAX_AUTH_TIMEOUT_MS).contains(&value) {
        anyhow::bail!(
            "NYABASE_SSH_AUTH_TIMEOUT_MS must be in {MIN_AUTH_TIMEOUT_MS}..={MAX_AUTH_TIMEOUT_MS}"
        );
    }
    Ok(value)
}

pub(crate) fn validate_control_hold(value: u64) -> Result<u64> {
    if !(SSH_PROXY_CONTROL_HOLD_MIN_MS..=SSH_PROXY_CONTROL_HOLD_MAX_MS).contains(&value) {
        anyhow::bail!(
            "NYABASE_SSH_CONTROL_HOLD_MS must be in {SSH_PROXY_CONTROL_HOLD_MIN_MS}..={SSH_PROXY_CONTROL_HOLD_MAX_MS}"
        );
    }
    Ok(value)
}

#[cfg(test)]
#[path = "config_tests.rs"]
mod tests;
