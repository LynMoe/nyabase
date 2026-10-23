use anyhow::Result;
use proxy_common::clock::now_ms;
use proxy_common::conn_limit::ConnectionLimiter;
use proxy_common::supervise::{spawn_supervised, supervise_until_shutdown};
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::mpsc;
use tokio::task::JoinSet;

mod chunked;
mod config;
mod control;
mod listener;
mod protocol;
mod relay;
mod request;
mod runtime;
mod snapshot;
#[cfg(test)]
mod test_support;
mod upstream;

use crate::config::Config;
use crate::control::{control_loop, snapshot_lease_loop, status_loop};
use crate::listener::http_listener;
use crate::runtime::Runtime;
use crate::snapshot::SnapshotStore;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    rustls::crypto::ring::default_provider()
        .install_default()
        .ok();

    let config = Config::from_env()?;
    let store = Arc::new(SnapshotStore::default());
    let runtime = Arc::new(Runtime {
        proxy_id: format!("http-proxy-{}", now_ms()),
        hostname: std::env::var("HOSTNAME").ok(),
        http_listen: config.http_listen.clone(),
        https_listen: config.https_listen.clone(),
        started_at: Instant::now(),
        limits: config.limits,
        connected_at: AtomicU64::new(0),
        last_snapshot_generation: AtomicU64::new(0),
        last_snapshot_at: AtomicU64::new(0),
        active_connections: AtomicU64::new(0),
        total_requests: AtomicU64::new(0),
        total_rejected_requests: AtomicU64::new(0),
    });
    let (status_tx, status_rx) = mpsc::channel(32);
    // HTTP and HTTPS listeners share one pool so the caps are per process.
    let connection_slots = ConnectionLimiter::new(config.connection_limits());
    let mut tasks = JoinSet::new();

    spawn_supervised(
        &mut tasks,
        "HTTP proxy control loop",
        control_loop(config.clone(), store.clone(), runtime.clone(), status_rx),
    );
    spawn_supervised(
        &mut tasks,
        "HTTP proxy status loop",
        status_loop(config.clone(), runtime.clone(), status_tx),
    );
    spawn_supervised(
        &mut tasks,
        "HTTP proxy snapshot lease loop",
        snapshot_lease_loop(store.clone()),
    );
    spawn_supervised(
        &mut tasks,
        "HTTP proxy listener",
        http_listener(
            config.http_listen.clone(),
            store.clone(),
            runtime.clone(),
            connection_slots.clone(),
            false,
        ),
    );
    if let Some(listen) = config.https_listen.clone() {
        spawn_supervised(
            &mut tasks,
            "HTTPS proxy listener",
            http_listener(listen, store, runtime, connection_slots, true),
        );
    }

    supervise_until_shutdown("HTTP proxy", &mut tasks).await
}
