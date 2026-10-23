//! Concurrent connections per upstream container.
//!
//! The listener-wide pool (`proxy_common::conn_limit`) only stops one client
//! from filling it; one popular or hostile site could still hold every slot
//! with long-lived tunnels or slow responses and take all other sites down.
//! A permit is taken once the route is resolved and held until the exchange
//! (or its upgraded tunnel) ends. Keying on the container rather than the
//! hostname means extra hostnames bound to one container share its cap.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

#[derive(Debug)]
pub(crate) struct ContainerLimiter {
    per_container: usize,
    counts: Mutex<HashMap<String, usize>>,
}

/// Releases the container's slot on drop.
#[derive(Debug)]
pub(crate) struct ContainerPermit {
    limiter: Arc<ContainerLimiter>,
    container_id: String,
}

impl ContainerLimiter {
    pub(crate) fn new(per_container: usize) -> Arc<Self> {
        Arc::new(Self {
            per_container,
            counts: Mutex::new(HashMap::new()),
        })
    }

    pub(crate) fn try_acquire(self: &Arc<Self>, container_id: &str) -> Option<ContainerPermit> {
        let mut counts = self.lock();
        let count = counts.get(container_id).copied().unwrap_or(0);
        if count >= self.per_container {
            return None;
        }
        counts.insert(container_id.to_string(), count + 1);
        Some(ContainerPermit {
            limiter: self.clone(),
            container_id: container_id.to_string(),
        })
    }

    #[cfg(test)]
    pub(crate) fn active_for(&self, container_id: &str) -> usize {
        self.lock().get(container_id).copied().unwrap_or(0)
    }

    #[cfg(test)]
    pub(crate) fn tracked_containers(&self) -> usize {
        self.lock().len()
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, usize>> {
        self.counts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl Drop for ContainerPermit {
    fn drop(&mut self) {
        let mut counts = self.limiter.lock();
        if let Some(count) = counts.get_mut(&self.container_id) {
            *count -= 1;
            if *count == 0 {
                counts.remove(&self.container_id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caps_each_container_separately_and_frees_on_drop() {
        let limiter = ContainerLimiter::new(2);
        let first = limiter.try_acquire("container-a").unwrap();
        let _second = limiter.try_acquire("container-a").unwrap();
        assert!(limiter.try_acquire("container-a").is_none());
        assert_eq!(limiter.active_for("container-a"), 2);
        // Another container is unaffected by a full one.
        let other = limiter.try_acquire("container-b").unwrap();
        drop(first);
        assert_eq!(limiter.active_for("container-a"), 1);
        assert!(limiter.try_acquire("container-a").is_some());
        drop(other);
        assert_eq!(limiter.active_for("container-b"), 0);
    }

    #[test]
    fn refused_attempts_and_released_containers_leave_no_entry() {
        let limiter = ContainerLimiter::new(1);
        let permit = limiter.try_acquire("container-a").unwrap();
        assert!(limiter.try_acquire("container-a").is_none());
        assert_eq!(limiter.active_for("container-a"), 1);
        drop(permit);
        assert_eq!(limiter.tracked_containers(), 0);
    }
}
