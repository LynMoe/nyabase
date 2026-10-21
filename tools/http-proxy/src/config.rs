use anyhow::{anyhow, Result};
use proxy_common::backend_tls::{backend_tls_config_from_env, validate_backend_ws_url};
use proxy_common::control_token::required_control_token;
use proxy_common::env::{env_u64, env_usize, validate_status_interval_ms};
use std::sync::Arc;
use std::time::Duration;

pub(crate) const MAX_REQUEST_HEADER_BYTES: usize = 64 * 1024;

pub(crate) const MAX_UPSTREAM_UPGRADE_HEADER_BYTES: usize = 64 * 1024;

pub(crate) const MAX_REQUEST_BODY_BYTES: usize = 16 * 1024 * 1024;

pub(crate) const REQUEST_HEADER_DEADLINE: Duration = Duration::from_secs(10);

pub(crate) const UPSTREAM_CONNECT_DEADLINE: Duration = Duration::from_secs(10);

pub(crate) const UPSTREAM_UPGRADE_HEADER_DEADLINE: Duration = Duration::from_secs(10);

pub(crate) const REQUEST_LIFETIME_DEADLINE: Duration = Duration::from_secs(120);

pub(crate) const CONTROL_WRITE_DEADLINE: Duration = Duration::from_secs(5);

pub(crate) const TLS_HANDSHAKE_DEADLINE: Duration = Duration::from_secs(10);

pub(crate) const MAX_SNAPSHOT_STALE_AFTER_MS: u64 = 300_000;

// A request may retain up to 16 MiB of body data. Keep the fixed global
// connection cap deliberately small so the worst-case resident set remains
// finite and operationally reasonable without another buffering subsystem.
pub(crate) const MAX_ACTIVE_CONNECTIONS: usize = 32;

#[derive(Clone)]
pub(crate) struct Config {
    pub(crate) backend_ws: String,
    pub(crate) backend_tls: Option<Arc<rustls::ClientConfig>>,
    pub(crate) token: String,
    pub(crate) http_listen: String,
    pub(crate) https_listen: Option<String>,
    pub(crate) max_connections: usize,
    pub(crate) reconnect_delay: Duration,
    pub(crate) status_interval: Duration,
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
        let max_connections = validate_connection_cap(env_usize(
            "NYABASE_HTTP_MAX_CONNECTIONS",
            MAX_ACTIVE_CONNECTIONS,
        )?)?;
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
            reconnect_delay,
            status_interval,
        })
    }
}

pub(crate) fn validate_connection_cap(value: usize) -> Result<usize> {
    if !(1..=MAX_ACTIVE_CONNECTIONS).contains(&value) {
        return Err(anyhow!(
            "NYABASE_HTTP_MAX_CONNECTIONS must be in 1..={MAX_ACTIVE_CONNECTIONS}"
        ));
    }
    Ok(value)
}

#[cfg(test)]
#[path = "config_tests.rs"]
mod tests;
