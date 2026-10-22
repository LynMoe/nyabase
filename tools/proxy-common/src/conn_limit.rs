//! Global and per-client-IP concurrent connection limits for public listeners.
//!
//! A permit is taken right after `accept()` and held for the whole life of
//! the connection (including upgraded tunnels), so one client address cannot
//! starve the global pool. IPv6 clients are bucketed by /64 because a single
//! subscriber usually controls a whole /64; IPv4-mapped IPv6 addresses are
//! counted as the IPv4 address they carry.

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
}

fn v6_prefix64(ip: Ipv6Addr) -> u64 {
    (u128::from(ip) >> 64) as u64
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LimitRejection {
    Global,
    PerClient,
}

impl LimitRejection {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::PerClient => "per_client",
        }
    }
}

#[derive(Debug)]
pub struct ConnectionLimiter {
    global: Arc<Semaphore>,
    per_client_max: usize,
    per_client: Mutex<HashMap<ClientBucket, usize>>,
}

/// Releases both the global slot and the per-client count on drop.
#[derive(Debug)]
pub struct ConnectionPermit {
    limiter: Arc<ConnectionLimiter>,
    bucket: ClientBucket,
    _global: OwnedSemaphorePermit,
}

impl ConnectionLimiter {
    pub fn new(global_max: usize, per_client_max: usize) -> Arc<Self> {
        Arc::new(Self {
            global: Arc::new(Semaphore::new(global_max)),
            per_client_max,
            per_client: Mutex::new(HashMap::new()),
        })
    }

    pub fn try_acquire(
        self: &Arc<Self>,
        ip: IpAddr,
    ) -> std::result::Result<ConnectionPermit, LimitRejection> {
        let bucket = ClientBucket::of(ip);
        let mut counts = self.lock();
        let count = counts.get(&bucket).copied().unwrap_or(0);
        if count >= self.per_client_max {
            return Err(LimitRejection::PerClient);
        }
        let global = self
            .global
            .clone()
            .try_acquire_owned()
            .map_err(|_| LimitRejection::Global)?;
        counts.insert(bucket, count + 1);
        Ok(ConnectionPermit {
            limiter: self.clone(),
            bucket,
            _global: global,
        })
    }

    pub fn active_for(&self, ip: IpAddr) -> usize {
        self.lock().get(&ClientBucket::of(ip)).copied().unwrap_or(0)
    }

    pub fn tracked_clients(&self) -> usize {
        self.lock().len()
    }

    fn release(&self, bucket: ClientBucket) {
        let mut counts = self.lock();
        if let Some(count) = counts.get_mut(&bucket) {
            *count -= 1;
            if *count == 0 {
                counts.remove(&bucket);
            }
        }
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<ClientBucket, usize>> {
        self.per_client
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
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
        let limiter = ConnectionLimiter::new(10, 2);
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
        let limiter = ConnectionLimiter::new(2, 10);
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
        let limiter = ConnectionLimiter::new(10, 2);
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
        let limiter = ConnectionLimiter::new(10, 2);
        let permit = limiter.try_acquire(ip("192.0.2.1")).unwrap();
        assert_eq!(limiter.tracked_clients(), 1);
        drop(permit);
        assert_eq!(limiter.tracked_clients(), 0);
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
