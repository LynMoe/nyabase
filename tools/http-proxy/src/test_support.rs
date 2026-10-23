use crate::config::{ConnectionLimits, DEFAULT_MAX_CONNECTIONS_PER_CONTAINER};
use crate::container_limit::ContainerLimiter;
use crate::protocol::ProxySnapshot;
use crate::request::ClientContext;
use crate::runtime::Runtime;
use crate::snapshot::Route;
use proxy_common::clock::now_ms;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use std::time::Instant;

pub(crate) fn test_snapshot(
    generation: u64,
    stale_after_ms: u64,
    routes: Vec<Route>,
) -> ProxySnapshot {
    ProxySnapshot {
        generation,
        stale_after_ms,
        valid_until_ms: now_ms() + stale_after_ms,
        routes,
        domain_pools: Vec::new(),
    }
}

pub(crate) fn test_route(target_port: u16) -> Route {
    Route {
        binding_id: "binding-a".into(),
        hostname: "app.example.test".into(),
        domain_pool_id: "pool-a".into(),
        routed_ip: "127.0.0.1".into(),
        target_port,
        owner_id: "user-a".into(),
        container_id: "container-a".into(),
        container_name: "app".into(),
        instance_name: "instance-a".into(),
        status: "running".into(),
    }
}

pub(crate) fn test_runtime() -> Arc<Runtime> {
    Arc::new(Runtime {
        proxy_id: "proxy-test".into(),
        hostname: Some("proxy.test".into()),
        http_listen: "127.0.0.1:0".into(),
        https_listen: None,
        started_at: Instant::now(),
        limits: ConnectionLimits::default(),
        container_slots: ContainerLimiter::new(DEFAULT_MAX_CONNECTIONS_PER_CONTAINER),
        connected_at: AtomicU64::new(0),
        last_snapshot_generation: AtomicU64::new(0),
        last_snapshot_at: AtomicU64::new(0),
        active_connections: AtomicU64::new(0),
        total_requests: AtomicU64::new(0),
        total_rejected_requests: AtomicU64::new(0),
    })
}

pub(crate) fn test_client() -> ClientContext {
    ClientContext {
        peer_ip: "192.0.2.10".parse().unwrap(),
        https: false,
    }
}
