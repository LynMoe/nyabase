//! Global, per-client-IP and pre-establishment connection limits for public
//! listeners.
//!
//! A permit is taken right after `accept()` and held for the whole life of
//! the connection (including upgraded tunnels), so one client address cannot
//! starve the global pool. IPv6 clients are bucketed by /64 because a single
//! subscriber usually controls a whole /64, and additionally aggregated per
//! /48 (a typical end-site allocation) so one site cannot fill the pool from
//! many /64s. IPv4-mapped IPv6 addresses are counted as the IPv4 address they
//! carry.
//!
//! Every new connection also holds a *pending* slot until the listener marks
//! it established (SSH: public-key authentication succeeded; HTTP: the
//! request head was read). The pending pool is smaller than the global pool,
//! so unauthenticated sockets cannot crowd out authenticated sessions.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::{Arc, Mutex, MutexGuard};

use anyhow::Result;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum ClientBucket {
    V4(Ipv4Addr),
    V6Prefix64(u64),
}

impl ClientBucket {
    pub fn of(ip: IpAddr) -> Self {
        match ip {
            IpAddr::V4(v4) => Self::V4(v4),
            IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
                Some(v4) => Self::V4(v4),
                None => Self::V6Prefix64(v6_prefix64(v6)),
            },
        }
    }

    /// The /48 aggregate of a native IPv6 client; IPv4 has none.
    pub fn site(self) -> Option<u64> {
        match self {
            Self::V4(_) => None,
            Self::V6Prefix64(prefix64) => Some(prefix64 >> 16),
        }
    }
}

fn v6_prefix64(ip: Ipv6Addr) -> u64 {
    (u128::from(ip) >> 64) as u64
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LimitRejection {
    Global,
    PerClient,
    PerSite,
    Pending,
}

impl LimitRejection {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::PerClient => "per_client",
            Self::PerSite => "per_site",
            Self::Pending => "pending",
        }
    }
}

/// Limits for one listener pool.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LimitSettings {
    /// All concurrent connections.
    pub global: usize,
    /// Per IPv4 address / IPv6 /64.
    pub per_client: usize,
    /// Per IPv6 /48 (sum over its /64s).
    pub per_site: usize,
    /// Connections not yet marked established (pre-auth / pre-header).
    pub pending: usize,
}

impl LimitSettings {
    /// Only global and per-client limits; the other two equal `global`.
    pub fn basic(global: usize, per_client: usize) -> Self {
        Self {
            global,
            per_client,
            per_site: global,
            pending: global,
        }
    }
}

#[derive(Debug, Default)]
struct Counts {
    clients: HashMap<ClientBucket, usize>,
    sites: HashMap<u64, usize>,
}

#[derive(Debug)]
pub struct ConnectionLimiter {
    global: Arc<Semaphore>,
    pending: Arc<Semaphore>,
    settings: LimitSettings,
    counts: Mutex<Counts>,
}

/// Releases the global slot and the per-client/per-site counts on drop.
#[derive(Debug)]
pub struct ConnectionPermit {
    limiter: Arc<ConnectionLimiter>,
    bucket: ClientBucket,
    pending: Option<PendingPermit>,
    _global: OwnedSemaphorePermit,
}

/// A pre-establishment slot; dropping it marks the connection established.
#[derive(Debug)]
pub struct PendingPermit(#[allow(dead_code)] OwnedSemaphorePermit);

impl ConnectionPermit {
    /// Moves the pending slot out so whoever learns that the connection is
    /// established (e.g. the authentication handler) can drop it.
    pub fn take_pending(&mut self) -> Option<PendingPermit> {
        self.pending.take()
    }

    /// Releases the pending slot now.
    pub fn mark_established(&mut self) {
        self.pending = None;
    }
}

impl ConnectionLimiter {
    pub fn new(settings: LimitSettings) -> Arc<Self> {
        Arc::new(Self {
            global: Arc::new(Semaphore::new(settings.global)),
            pending: Arc::new(Semaphore::new(settings.pending)),
            settings,
            counts: Mutex::new(Counts::default()),
        })
    }

    pub fn try_acquire(
        self: &Arc<Self>,
        ip: IpAddr,
    ) -> std::result::Result<ConnectionPermit, LimitRejection> {
        let bucket = ClientBucket::of(ip);
        let site = bucket.site();
        let mut counts = self.lock();
        let client_count = counts.clients.get(&bucket).copied().unwrap_or(0);
        if client_count >= self.settings.per_client {
            return Err(LimitRejection::PerClient);
        }
        if let Some(site) = site {
            if counts.sites.get(&site).copied().unwrap_or(0) >= self.settings.per_site {
                return Err(LimitRejection::PerSite);
            }
        }
        let global = self
            .global
            .clone()
            .try_acquire_owned()
            .map_err(|_| LimitRejection::Global)?;
        let pending = self
            .pending
            .clone()
            .try_acquire_owned()
            .map_err(|_| LimitRejection::Pending)?;
        counts.clients.insert(bucket, client_count + 1);
        if let Some(site) = site {
            *counts.sites.entry(site).or_insert(0) += 1;
        }
        Ok(ConnectionPermit {
            limiter: self.clone(),
            bucket,
            pending: Some(PendingPermit(pending)),
            _global: global,
        })
    }

    pub fn active_for(&self, ip: IpAddr) -> usize {
        self.lock()
            .clients
            .get(&ClientBucket::of(ip))
            .copied()
            .unwrap_or(0)
    }

    pub fn pending_available(&self) -> usize {
        self.pending.available_permits()
    }

    pub fn tracked_clients(&self) -> usize {
        self.lock().clients.len()
    }

    fn release(&self, bucket: ClientBucket) {
        let mut counts = self.lock();
        decrement(&mut counts.clients, bucket);
        if let Some(site) = bucket.site() {
            decrement(&mut counts.sites, site);
        }
    }

    fn lock(&self) -> MutexGuard<'_, Counts> {
        self.counts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn decrement<K: std::hash::Hash + Eq>(map: &mut HashMap<K, usize>, key: K) {
    if let Some(count) = map.get_mut(&key) {
        *count -= 1;
        if *count == 0 {
            map.remove(&key);
        }
    }
}

impl Drop for ConnectionPermit {
    fn drop(&mut self) {
        self.limiter.release(self.bucket);
    }
}

/// Validates an unsigned limit read from `name` (the env var) against `min..=max`.
pub fn validate_limit(name: &str, value: usize, min: usize, max: usize) -> Result<usize> {
    if !(min..=max).contains(&value) {
        anyhow::bail!("{name} must be in {min}..={max}");
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(value: &str) -> IpAddr {
        value.parse().unwrap()
    }

    #[test]
    fn per_client_limit_rejects_only_the_noisy_client() {
        let limiter = ConnectionLimiter::new(LimitSettings::basic(10, 2));
        let first = limiter.try_acquire(ip("192.0.2.1")).unwrap();
        let _second = limiter.try_acquire(ip("192.0.2.1")).unwrap();
        assert_eq!(
            limiter.try_acquire(ip("192.0.2.1")).unwrap_err(),
            LimitRejection::PerClient
        );
        let _other = limiter.try_acquire(ip("192.0.2.2")).unwrap();
        drop(first);
        assert!(limiter.try_acquire(ip("192.0.2.1")).is_ok());
    }

    #[test]
    fn global_limit_applies_across_clients_and_frees_on_drop() {
        let limiter = ConnectionLimiter::new(LimitSettings::basic(2, 10));
        let a = limiter.try_acquire(ip("192.0.2.1")).unwrap();
        let _b = limiter.try_acquire(ip("192.0.2.2")).unwrap();
        assert_eq!(
            limiter.try_acquire(ip("192.0.2.3")).unwrap_err(),
            LimitRejection::Global
        );
        // A rejected attempt must not leak a per-client count.
        assert_eq!(limiter.active_for(ip("192.0.2.3")), 0);
        drop(a);
        assert!(limiter.try_acquire(ip("192.0.2.3")).is_ok());
    }

    #[test]
    fn ipv6_clients_are_bucketed_by_slash_64_and_mapped_v4_by_address() {
        let limiter = ConnectionLimiter::new(LimitSettings::basic(10, 2));
        let _a = limiter.try_acquire(ip("2001:db8:1:2::1")).unwrap();
        let _b = limiter.try_acquire(ip("2001:db8:1:2:ffff::9")).unwrap();
        assert_eq!(
            limiter.try_acquire(ip("2001:db8:1:2:abcd::1")).unwrap_err(),
            LimitRejection::PerClient
        );
        assert!(limiter.try_acquire(ip("2001:db8:1:3::1")).is_ok());

        let _v4 = limiter.try_acquire(ip("198.51.100.7")).unwrap();
        let _mapped = limiter.try_acquire(ip("::ffff:198.51.100.7")).unwrap();
        assert_eq!(
            limiter.try_acquire(ip("198.51.100.7")).unwrap_err(),
            LimitRejection::PerClient
        );
    }

    #[test]
    fn idle_buckets_are_forgotten() {
        let limiter = ConnectionLimiter::new(LimitSettings::basic(10, 2));
        let permit = limiter.try_acquire(ip("192.0.2.1")).unwrap();
        assert_eq!(limiter.tracked_clients(), 1);
        drop(permit);
        assert_eq!(limiter.tracked_clients(), 0);
    }

    #[test]
    fn ipv6_sites_are_also_capped_per_slash_48() {
        let limiter = ConnectionLimiter::new(LimitSettings {
            global: 100,
            per_client: 2,
            per_site: 3,
            pending: 100,
        });
        let _a = limiter.try_acquire(ip("2001:db8:1:1::1")).unwrap();
        let _b = limiter.try_acquire(ip("2001:db8:1:2::1")).unwrap();
        let c = limiter.try_acquire(ip("2001:db8:1:3::1")).unwrap();
        // A fourth /64 in the same /48 is refused even though its own
        // bucket is empty; another /48 and IPv4 are unaffected.
        assert_eq!(
            limiter.try_acquire(ip("2001:db8:1:4::1")).unwrap_err(),
            LimitRejection::PerSite
        );
        assert!(limiter.try_acquire(ip("2001:db8:2:1::1")).is_ok());
        assert!(limiter.try_acquire(ip("192.0.2.1")).is_ok());
        drop(c);
        assert!(limiter.try_acquire(ip("2001:db8:1:4::1")).is_ok());
    }

    #[test]
    fn pending_slots_are_smaller_than_the_pool_and_freed_on_establishment() {
        let limiter = ConnectionLimiter::new(LimitSettings {
            global: 4,
            per_client: 4,
            per_site: 4,
            pending: 2,
        });
        let mut a = limiter.try_acquire(ip("192.0.2.1")).unwrap();
        let b = limiter.try_acquire(ip("192.0.2.2")).unwrap();
        assert_eq!(
            limiter.try_acquire(ip("192.0.2.3")).unwrap_err(),
            LimitRejection::Pending
        );
        // A rejected attempt does not leak a per-client count.
        assert_eq!(limiter.active_for(ip("192.0.2.3")), 0);
        a.mark_established();
        let mut c = limiter.try_acquire(ip("192.0.2.3")).unwrap();
        let pending = c.take_pending().expect("pending slot");
        assert_eq!(limiter.pending_available(), 0);
        drop(pending);
        assert_eq!(limiter.pending_available(), 1);
        drop(b);
        let mut d = limiter.try_acquire(ip("192.0.2.4")).unwrap();
        d.mark_established();
        // Established connections still count against the global pool.
        let _e = limiter.try_acquire(ip("192.0.2.5")).unwrap();
        assert_eq!(
            limiter.try_acquire(ip("192.0.2.6")).unwrap_err(),
            LimitRejection::Global
        );
        drop(c);
    }

    #[test]
    fn limits_are_bounded_and_name_the_variable() {
        assert_eq!(validate_limit("X", 1, 1, 4).unwrap(), 1);
        assert_eq!(validate_limit("X", 4, 1, 4).unwrap(), 4);
        assert!(validate_limit("X", 0, 1, 4).is_err());
        let error = validate_limit("NYABASE_X_PER_IP", 5, 1, 4).unwrap_err();
        assert!(error.to_string().contains("NYABASE_X_PER_IP"));
    }
}
