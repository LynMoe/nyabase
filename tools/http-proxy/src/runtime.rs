use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::OwnedSemaphorePermit;

pub(crate) struct Runtime {
    pub(crate) proxy_id: String,
    pub(crate) hostname: Option<String>,
    pub(crate) http_listen: String,
    pub(crate) https_listen: Option<String>,
    pub(crate) started_at: Instant,
    pub(crate) connected_at: AtomicU64,
    pub(crate) last_snapshot_generation: AtomicU64,
    pub(crate) last_snapshot_at: AtomicU64,
    pub(crate) active_connections: AtomicU64,
    pub(crate) total_requests: AtomicU64,
    pub(crate) total_rejected_requests: AtomicU64,
}

pub(crate) struct ActiveConnectionGuard {
    pub(crate) runtime: Arc<Runtime>,
    pub(crate) _permit: OwnedSemaphorePermit,
}

impl ActiveConnectionGuard {
    pub(crate) fn new(runtime: Arc<Runtime>, permit: OwnedSemaphorePermit) -> Self {
        runtime.active_connections.fetch_add(1, Ordering::Relaxed);
        Self {
            runtime,
            _permit: permit,
        }
    }
}

impl Drop for ActiveConnectionGuard {
    fn drop(&mut self) {
        self.runtime
            .active_connections
            .fetch_sub(1, Ordering::Relaxed);
    }
}
