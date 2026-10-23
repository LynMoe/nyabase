//! Concurrent connections per upstream container, per client per container,
//! and per container owner.
//!
//! The listener-wide pool (`proxy_common::conn_limit`) only stops one client
//! from filling it; one popular or hostile site could still hold every slot
//! with long-lived tunnels or slow responses and take all other sites down.
//! A permit is taken once the route is resolved and held until the exchange
//! (or its upgraded tunnel) ends. Three caps apply:
//!
//! - per container, so one site cannot take the whole pool; keying on the
//!   container rather than the hostname means extra hostnames bound to one
//!   container share its cap;
//! - per client (IPv4 address / IPv6 /64) per container, so a handful of
//!   clients dripping request bodies or holding WebSocket upgrades cannot
//!   fill a victim container's slots and lock every other visitor out;
//! - per owner, all of one user's containers together, so one tenant with
//!   many containers cannot take the whole pool either.

use proxy_common::conn_limit::ClientBucket;
use std::collections::HashMap;
use std::hash::Hash;
use std::net::IpAddr;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// A saturated container is logged at warn level at most this often, so a
/// flood of refused requests cannot flood the log as well.
pub(crate) const REFUSAL_WARN_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct UpstreamCaps {
    pub(crate) per_container: usize,
    pub(crate) per_client_per_container: usize,
    pub(crate) per_owner: usize,
}

impl UpstreamCaps {
    /// Only the per-container cap; the others impose nothing extra.
    #[cfg(test)]
    pub(crate) fn per_container(per_container: usize) -> Self {
        Self {
            per_container,
            per_client_per_container: per_container,
            per_owner: usize::MAX,
        }
    }
}

/// Which cap refused an exchange.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum UpstreamRefusal {
    Container,
    ClientPerContainer,
    Owner,
}

impl UpstreamRefusal {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Container => "per_container",
            Self::ClientPerContainer => "per_client_per_container",
            Self::Owner => "per_owner",
        }
    }
}

#[derive(Debug, Default)]
struct Counts {
    containers: HashMap<String, usize>,
    client_containers: HashMap<(ClientBucket, String), usize>,
    owners: HashMap<String, usize>,
}

#[derive(Debug)]
pub(crate) struct ContainerLimiter {
    caps: UpstreamCaps,
    counts: Mutex<Counts>,
    /// Refusals warned about within the last `REFUSAL_WARN_INTERVAL`, keyed
    /// by cap and container or owner id; older entries are pruned whenever
    /// a new key is warned about.
    refusals: Mutex<HashMap<(UpstreamRefusalKey, String), RefusalLog>>,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum UpstreamRefusalKey {
    Container,
    Owner,
}

#[derive(Debug)]
struct RefusalLog {
    warned_at: Instant,
    /// Refusals since `warned_at` that were not logged.
    suppressed: u64,
}

/// Releases the exchange's slots on drop.
#[derive(Debug)]
pub(crate) struct ContainerPermit {
    limiter: Arc<ContainerLimiter>,
    client: ClientBucket,
    container_id: String,
    owner_id: String,
}

impl ContainerLimiter {
    pub(crate) fn new(caps: UpstreamCaps) -> Arc<Self> {
        Arc::new(Self {
            caps,
            counts: Mutex::new(Counts::default()),
            refusals: Mutex::new(HashMap::new()),
        })
    }

    pub(crate) fn caps(&self) -> UpstreamCaps {
        self.caps
    }

    pub(crate) fn try_acquire(
        self: &Arc<Self>,
        client: IpAddr,
        container_id: &str,
        owner_id: &str,
    ) -> Result<ContainerPermit, UpstreamRefusal> {
        let client = ClientBucket::of(client);
        let client_key = (client, container_id.to_string());
        let mut counts = self.lock();
        // The most specific cap first, so a noisy client is refused as such
        // before it is counted against the whole container.
        if count(&counts.client_containers, &client_key) >= self.caps.per_client_per_container {
            return Err(UpstreamRefusal::ClientPerContainer);
        }
        if count(&counts.containers, container_id) >= self.caps.per_container {
            return Err(UpstreamRefusal::Container);
        }
        if count(&counts.owners, owner_id) >= self.caps.per_owner {
            return Err(UpstreamRefusal::Owner);
        }
        *counts.client_containers.entry(client_key).or_insert(0) += 1;
        *counts
            .containers
            .entry(container_id.to_string())
            .or_insert(0) += 1;
        *counts.owners.entry(owner_id.to_string()).or_insert(0) += 1;
        Ok(ContainerPermit {
            limiter: self.clone(),
            client,
            container_id: container_id.to_string(),
            owner_id: owner_id.to_string(),
        })
    }

    /// Records a refusal by `refusal` for the container or owner `id`.
    /// Returns the number of refusals to report (this one plus those
    /// suppressed since the last warning) when a warning is due, i.e. at
    /// most once per `REFUSAL_WARN_INTERVAL` per cap and id. Per-client
    /// refusals are never warned about: they are one client's excess, not a
    /// saturated site.
    pub(crate) fn note_refusal(
        &self,
        refusal: UpstreamRefusal,
        id: &str,
        now: Instant,
    ) -> Option<u64> {
        let key = match refusal {
            UpstreamRefusal::Container => UpstreamRefusalKey::Container,
            UpstreamRefusal::Owner => UpstreamRefusalKey::Owner,
            UpstreamRefusal::ClientPerContainer => return None,
        };
        let mut refusals = self
            .refusals
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let key = (key, id.to_string());
        if let Some(log) = refusals.get_mut(&key) {
            if now.saturating_duration_since(log.warned_at) < REFUSAL_WARN_INTERVAL {
                log.suppressed += 1;
                return None;
            }
            let refused = log.suppressed + 1;
            log.warned_at = now;
            log.suppressed = 0;
            return Some(refused);
        }
        refusals
            .retain(|_, log| now.saturating_duration_since(log.warned_at) < REFUSAL_WARN_INTERVAL);
        refusals.insert(
            key,
            RefusalLog {
                warned_at: now,
                suppressed: 0,
            },
        );
        Some(1)
    }

    #[cfg(test)]
    pub(crate) fn active_for(&self, container_id: &str) -> usize {
        count(&self.lock().containers, container_id)
    }

    #[cfg(test)]
    pub(crate) fn active_for_owner(&self, owner_id: &str) -> usize {
        count(&self.lock().owners, owner_id)
    }

    #[cfg(test)]
    pub(crate) fn tracked_entries(&self) -> usize {
        let counts = self.lock();
        counts.containers.len() + counts.client_containers.len() + counts.owners.len()
    }

    fn lock(&self) -> MutexGuard<'_, Counts> {
        self.counts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn count<K, Q>(map: &HashMap<K, usize>, key: &Q) -> usize
where
    K: std::borrow::Borrow<Q> + Eq + Hash,
    Q: Eq + Hash + ?Sized,
{
    map.get(key).copied().unwrap_or(0)
}

fn decrement<K, Q>(map: &mut HashMap<K, usize>, key: &Q)
where
    K: std::borrow::Borrow<Q> + Eq + Hash,
    Q: Eq + Hash + ?Sized,
{
    if let Some(count) = map.get_mut(key) {
        *count -= 1;
        if *count == 0 {
            map.remove(key);
        }
    }
}

impl Drop for ContainerPermit {
    fn drop(&mut self) {
        let client_key = (self.client, std::mem::take(&mut self.container_id));
        let mut counts = self.limiter.lock();
        decrement(&mut counts.containers, client_key.1.as_str());
        decrement(&mut counts.client_containers, &client_key);
        decrement(&mut counts.owners, self.owner_id.as_str());
    }
}

#[cfg(test)]
#[path = "container_limit_tests.rs"]
mod tests;
