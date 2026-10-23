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
//! so unauthenticated sockets cannot crowd out authenticated sessions, and it
//! is shared fairly between sources rather than first come, first served:
//!
//! - each IPv4 address / IPv6 /64 and each IPv6 /48 may hold only a small
//!   number of pending slots (`pending_per_client`, `pending_per_site`);
//! - when the pool is full, a newcomer whose source (IPv4 address or IPv6
//!   /48) holds at least two fewer pending slots than the heaviest source
//!   evicts that source's oldest pending connection instead of being
//!   refused. The evicted connection is told through its
//!   [`PendingEviction`] and closes itself.
//!
//! A few sources therefore cannot keep the pool to themselves: filling it
//! against fresh clients takes as many distinct sources as there are pending
//! slots, each holding one.

use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use anyhow::Result;
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore};

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

    /// The unit pending slots are shared fairly between: an IPv4 address or
    /// a whole IPv6 /48, so one site cannot look like many light sources.
    fn pending_source(self) -> PendingSource {
        match self {
            Self::V4(v4) => PendingSource::V4(v4),
            Self::V6Prefix64(prefix64) => PendingSource::V6Site(prefix64 >> 16),
        }
    }
}

fn v6_prefix64(ip: Ipv6Addr) -> u64 {
    (u128::from(ip) >> 64) as u64
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum PendingSource {
    V4(Ipv4Addr),
    V6Site(u64),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LimitRejection {
    Global,
    PerClient,
    PerSite,
    Pending,
    PendingPerClient,
    PendingPerSite,
}

impl LimitRejection {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::PerClient => "per_client",
            Self::PerSite => "per_site",
            Self::Pending => "pending",
            Self::PendingPerClient => "pending_per_client",
            Self::PendingPerSite => "pending_per_site",
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
    /// Pending connections per IPv4 address / IPv6 /64.
    pub pending_per_client: usize,
    /// Pending connections per IPv6 /48 (sum over its /64s).
    pub pending_per_site: usize,
}

impl LimitSettings {
    /// Only global and per-client limits; the others impose nothing extra.
    pub fn basic(global: usize, per_client: usize) -> Self {
        Self {
            global,
            per_client,
            per_site: global,
            pending: global,
            pending_per_client: per_client,
            pending_per_site: global,
        }
    }
}

#[derive(Debug, Default)]
struct Counts {
    clients: HashMap<ClientBucket, usize>,
    sites: HashMap<u64, usize>,
    pending_total: usize,
    pending_clients: HashMap<ClientBucket, usize>,
    /// Pending slots per fairness source, oldest first.
    pending_sources: HashMap<PendingSource, VecDeque<Arc<PendingSlot>>>,
}

#[derive(Debug)]
pub struct ConnectionLimiter {
    global: Arc<Semaphore>,
    settings: LimitSettings,
    counts: Mutex<Counts>,
    next_pending_id: AtomicU64,
    evicted_total: AtomicU64,
}

/// Releases the global slot and the per-client/per-site counts on drop.
#[derive(Debug)]
pub struct ConnectionPermit {
    limiter: Arc<ConnectionLimiter>,
    bucket: ClientBucket,
    pending: Option<PendingPermit>,
    _global: OwnedSemaphorePermit,
}

#[derive(Debug)]
struct PendingSlot {
    id: u64,
    bucket: ClientBucket,
    evicted: AtomicBool,
    notify: Notify,
}

/// A pre-establishment slot; dropping it marks the connection established.
#[derive(Debug)]
pub struct PendingPermit {
    limiter: Arc<ConnectionLimiter>,
    slot: Arc<PendingSlot>,
}

/// Resolves once the pending slot it came from was evicted under pressure.
/// It never resolves after the slot was released normally (the connection
/// became established), so a connection may keep waiting on it for its whole
/// life.
#[derive(Clone, Debug)]
pub struct PendingEviction(Arc<PendingSlot>);

impl PendingEviction {
    pub async fn wait(&self) {
        // One waiter per slot: `notify_one` stores a permit when nobody is
        // waiting yet, so the flag check cannot miss an eviction.
        while !self.0.evicted.load(Ordering::Acquire) {
            self.0.notify.notified().await;
        }
    }

    pub fn is_evicted(&self) -> bool {
        self.0.evicted.load(Ordering::Acquire)
    }
}

/// Waits for `eviction`, or forever when there is none.
pub async fn wait_evicted(eviction: Option<&PendingEviction>) {
    match eviction {
        Some(eviction) => eviction.wait().await,
        None => std::future::pending().await,
    }
}

impl PendingPermit {
    pub fn eviction(&self) -> PendingEviction {
        PendingEviction(self.slot.clone())
    }
}

impl Drop for PendingPermit {
    fn drop(&mut self) {
        self.limiter.release_pending(&self.slot);
    }
}

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
            settings,
            counts: Mutex::new(Counts::default()),
            next_pending_id: AtomicU64::new(1),
            evicted_total: AtomicU64::new(0),
        })
    }

    pub fn try_acquire(
        self: &Arc<Self>,
        ip: IpAddr,
    ) -> std::result::Result<ConnectionPermit, LimitRejection> {
        let bucket = ClientBucket::of(ip);
        let site = bucket.site();
        let source = bucket.pending_source();
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
        if counts.pending_clients.get(&bucket).copied().unwrap_or(0)
            >= self.settings.pending_per_client
        {
            return Err(LimitRejection::PendingPerClient);
        }
        let source_pending = counts.pending_sources.get(&source).map_or(0, VecDeque::len);
        if site.is_some() && source_pending >= self.settings.pending_per_site {
            return Err(LimitRejection::PendingPerSite);
        }
        let global = self
            .global
            .clone()
            .try_acquire_owned()
            .map_err(|_| LimitRejection::Global)?;
        if counts.pending_total >= self.settings.pending {
            let victim =
                heaviest_victim(&mut counts, source_pending).ok_or(LimitRejection::Pending)?;
            forget_pending(&mut counts, &victim.bucket);
            victim.evicted.store(true, Ordering::Release);
            victim.notify.notify_one();
            self.evicted_total.fetch_add(1, Ordering::Relaxed);
        }
        let slot = Arc::new(PendingSlot {
            id: self.next_pending_id.fetch_add(1, Ordering::Relaxed),
            bucket,
            evicted: AtomicBool::new(false),
            notify: Notify::new(),
        });
        counts.pending_total += 1;
        *counts.pending_clients.entry(bucket).or_insert(0) += 1;
        counts
            .pending_sources
            .entry(source)
            .or_default()
            .push_back(slot.clone());
        counts.clients.insert(bucket, client_count + 1);
        if let Some(site) = site {
            *counts.sites.entry(site).or_insert(0) += 1;
        }
        Ok(ConnectionPermit {
            limiter: self.clone(),
            bucket,
            pending: Some(PendingPermit {
                limiter: self.clone(),
                slot,
            }),
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

    pub fn pending_for(&self, ip: IpAddr) -> usize {
        self.lock()
            .pending_clients
            .get(&ClientBucket::of(ip))
            .copied()
            .unwrap_or(0)
    }

    pub fn pending_available(&self) -> usize {
        self.settings
            .pending
            .saturating_sub(self.lock().pending_total)
    }

    /// Pending connections evicted to make room for lighter sources.
    pub fn evicted_total(&self) -> u64 {
        self.evicted_total.load(Ordering::Relaxed)
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

    /// Releases a pending slot unless an eviction already did.
    fn release_pending(&self, slot: &Arc<PendingSlot>) {
        let mut counts = self.lock();
        let source = slot.bucket.pending_source();
        let Some(queue) = counts.pending_sources.get_mut(&source) else {
            return;
        };
        let Some(index) = queue.iter().position(|queued| queued.id == slot.id) else {
            return;
        };
        queue.remove(index);
        if queue.is_empty() {
            counts.pending_sources.remove(&source);
        }
        forget_pending(&mut counts, &slot.bucket);
    }

    fn lock(&self) -> MutexGuard<'_, Counts> {
        self.counts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Removes and returns the oldest pending slot of the source holding the
/// most pending slots, if that source holds at least two more than the
/// newcomer's (`newcomer_pending`), so an eviction never leaves the victim's
/// source with fewer slots than the newcomer's.
fn heaviest_victim(counts: &mut Counts, newcomer_pending: usize) -> Option<Arc<PendingSlot>> {
    let (source, held) = counts
        .pending_sources
        .iter()
        .map(|(source, queue)| (*source, queue.len()))
        .max_by_key(|(_, held)| *held)?;
    if held <= newcomer_pending + 1 {
        return None;
    }
    let queue = counts.pending_sources.get_mut(&source)?;
    let victim = queue.pop_front();
    if queue.is_empty() {
        counts.pending_sources.remove(&source);
    }
    victim
}

/// Drops the total and per-client pending counts of one slot already taken
/// out of its source queue.
fn forget_pending(counts: &mut Counts, bucket: &ClientBucket) {
    counts.pending_total = counts.pending_total.saturating_sub(1);
    decrement(&mut counts.pending_clients, *bucket);
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
        // The pending slot (if still held here) is released by its own drop.
        self.pending = None;
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
#[path = "conn_limit_tests.rs"]
mod tests;
