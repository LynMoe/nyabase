use anyhow::Result;
use proxy_common::supervise::{spawn_supervised, supervise_until_shutdown};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio::task::JoinSet;

mod bridge;
mod config;
mod control;
mod history;
mod listener;
mod protocol;
mod proxy_protocol;
mod runtime;
mod session;
mod snapshot;
#[cfg(test)]
mod test_support;

use crate::config::ProxyConfig;
use crate::control::{run_backend_loop, run_control_timers, ControlPlane};
use crate::listener::run_public_listener;
use crate::runtime::ProxyRuntime;
use crate::snapshot::SnapshotStore;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    rustls::crypto::ring::default_provider()
        .install_default()
        .ok();

    let config = ProxyConfig::from_env()?;
    let store = Arc::new(SnapshotStore::default());
    let runtime = Arc::new(ProxyRuntime::new(&config));
    let control = Arc::new(ControlPlane::new());
    let (telemetry_tx, telemetry_rx) = mpsc::channel(4096);
    let mut tasks = JoinSet::new();

    spawn_supervised(
        &mut tasks,
        "SSH proxy backend loop",
        run_backend_loop(
            config.clone(),
            store.clone(),
            runtime.clone(),
            control.clone(),
            telemetry_rx,
        ),
    );
    spawn_supervised(
        &mut tasks,
        "SSH proxy control timers",
        run_control_timers(store.clone(), runtime.clone(), control.clone()),
    );
    spawn_supervised(
        &mut tasks,
        "SSH proxy public listener",
        run_public_listener(config, store, runtime, control, telemetry_tx),
    );

    supervise_until_shutdown("SSH proxy", &mut tasks).await
}
