use crate::config::MAX_SNAPSHOT_STALE_AFTER_MS;
use crate::protocol::ProxySnapshot;
use anyhow::{anyhow, Context, Result};
use proxy_common::clock::{absolute_snapshot_remaining, now_ms};
use rustls::pki_types::CertificateDer;
use rustls::server::{ClientHello, ResolvesServerCert};
use rustls::sign::CertifiedKey;
use serde::Deserialize;
use std::collections::HashMap;
use std::io::BufReader;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;
use tokio::sync::watch;
use tracing::{info, warn};

#[derive(Debug)]
pub(crate) struct SnapshotStore {
    pub(crate) state: Mutex<SnapshotState>,
    pub(crate) revision: AtomicU64,
    pub(crate) changes: watch::Sender<u64>,
}

#[derive(Debug)]
pub(crate) struct SnapshotState {
    pub(crate) current: Option<Arc<RoutingSnapshot>>,
    pub(crate) generation_high_water: Option<u64>,
    pub(crate) control_epoch: Arc<()>,
    pub(crate) authorization_epoch: Arc<()>,
}

impl Default for SnapshotState {
    fn default() -> Self {
        Self {
            current: None,
            generation_high_water: None,
            control_epoch: Arc::new(()),
            authorization_epoch: Arc::new(()),
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct SnapshotLease {
    pub(crate) generation: u64,
    pub(crate) deadline: Instant,
    pub(crate) control_epoch: Arc<()>,
}

#[derive(Clone, Debug)]
pub(crate) struct RouteAuthorization {
    pub(crate) route: Route,
    pub(crate) authorization_epoch: Arc<()>,
}

impl Default for SnapshotStore {
    fn default() -> Self {
        let (changes, _) = watch::channel(0);
        Self {
            state: Mutex::new(SnapshotState::default()),
            revision: AtomicU64::new(0),
            changes,
        }
    }
}

impl SnapshotStore {
    pub(crate) fn store(&self, snapshot: ProxySnapshot) -> Result<Option<SnapshotLease>> {
        let generation = snapshot.generation;
        let received_at = Instant::now();
        let routing = Arc::new(RoutingSnapshot::from_received(snapshot, received_at)?);
        if !routing.is_fresh(Instant::now()) {
            return Err(anyhow!(
                "HTTP proxy snapshot lease expired before installation"
            ));
        }
        let mut state = self.lock_state();
        let expired = state
            .current
            .as_ref()
            .is_some_and(|current| !current.is_fresh(received_at));
        if expired {
            state.current = None;
            state.authorization_epoch = Arc::new(());
        }
        if state
            .generation_high_water
            .is_some_and(|current| current >= generation)
        {
            drop(state);
            if expired {
                self.signal_change();
            }
            warn!(generation, "rejected non-increasing HTTP proxy snapshot");
            return Ok(None);
        }
        let contracts_authority = state.current.as_ref().is_some_and(|current| {
            current.routes.values().any(|old_route| {
                routing
                    .routes
                    .get(&old_route.hostname)
                    .is_none_or(|new_route| !new_route.same_authority(old_route))
            })
        });
        if contracts_authority {
            state.authorization_epoch = Arc::new(());
        }
        let lease = SnapshotLease {
            generation,
            deadline: routing.deadline,
            control_epoch: state.control_epoch.clone(),
        };
        let route_count = routing.routes.len();
        state.current = Some(routing);
        state.generation_high_water = Some(generation);
        drop(state);
        self.signal_change();
        info!(generation, route_count, "installed HTTP proxy snapshot");
        Ok(Some(lease))
    }

    pub(crate) fn load(&self) -> Option<Arc<RoutingSnapshot>> {
        let now = Instant::now();
        let mut state = self.lock_state();
        let expired = state
            .current
            .as_ref()
            .is_some_and(|current| !current.is_fresh(now));
        if expired {
            state.current = None;
            state.authorization_epoch = Arc::new(());
        }
        let current = state.current.clone();
        drop(state);
        if expired {
            self.signal_change();
        }
        current
    }

    pub(crate) fn expire(&self, lease: SnapshotLease) -> bool {
        let now = Instant::now();
        let mut state = self.lock_state();
        let should_expire = state.current.as_ref().is_some_and(|current| {
            Arc::ptr_eq(&state.control_epoch, &lease.control_epoch)
                && current.generation == lease.generation
                && current.deadline == lease.deadline
                && !current.is_fresh(now)
        });
        if should_expire {
            state.current = None;
            state.authorization_epoch = Arc::new(());
        }
        drop(state);
        if should_expire {
            self.signal_change();
            warn!(
                generation = lease.generation,
                "HTTP proxy snapshot lease expired"
            );
        }
        should_expire
    }

    pub(crate) fn clear_epoch(&self) {
        let mut state = self.lock_state();
        state.current = None;
        state.generation_high_water = None;
        state.control_epoch = Arc::new(());
        state.authorization_epoch = Arc::new(());
        drop(state);
        self.signal_change();
    }

    pub(crate) fn subscribe(&self) -> watch::Receiver<u64> {
        self.changes.subscribe()
    }

    #[cfg(test)]
    pub(crate) fn route_is_current(&self, expected: &Route) -> bool {
        self.authorize_route(&expected.hostname)
            .is_some_and(|current| current.route.same_authority(expected))
    }

    pub(crate) fn authorize_route(&self, hostname: &str) -> Option<RouteAuthorization> {
        let now = Instant::now();
        let mut state = self.lock_state();
        let expired = state
            .current
            .as_ref()
            .is_some_and(|current| !current.is_fresh(now));
        if expired {
            state.current = None;
            state.authorization_epoch = Arc::new(());
        }
        let authorization = state.current.as_ref().and_then(|snapshot| {
            snapshot
                .routes
                .get(hostname)
                .cloned()
                .map(|route| RouteAuthorization {
                    route,
                    authorization_epoch: state.authorization_epoch.clone(),
                })
        });
        drop(state);
        if expired {
            self.signal_change();
        }
        authorization
    }

    pub(crate) fn authorization_is_current(&self, expected: &RouteAuthorization) -> bool {
        self.authorization_deadline(expected).is_some()
    }

    pub(crate) fn authorization_deadline(&self, expected: &RouteAuthorization) -> Option<Instant> {
        let now = Instant::now();
        let mut state = self.lock_state();
        let expired = state
            .current
            .as_ref()
            .is_some_and(|current| !current.is_fresh(now));
        if expired {
            state.current = None;
            state.authorization_epoch = Arc::new(());
        }
        let deadline =
            if !expired && Arc::ptr_eq(&state.authorization_epoch, &expected.authorization_epoch) {
                state.current.as_ref().and_then(|snapshot| {
                    snapshot
                        .routes
                        .get(&expected.route.hostname)
                        .filter(|route| route.same_authority(&expected.route))
                        .map(|_| snapshot.deadline)
                })
            } else {
                None
            };
        drop(state);
        if expired {
            self.signal_change();
        }
        deadline
    }

    pub(crate) fn signal_change(&self) {
        let revision = self.revision.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = self.changes.send(revision);
    }

    pub(crate) fn lock_state(&self) -> MutexGuard<'_, SnapshotState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[derive(Clone, Debug)]
pub(crate) struct RoutingSnapshot {
    pub(crate) generation: u64,
    pub(crate) received_at: Instant,
    pub(crate) deadline: Instant,
    pub(crate) routes: HashMap<String, Route>,
    pub(crate) certs: Vec<DomainCert>,
}

impl RoutingSnapshot {
    pub(crate) fn from_received(snapshot: ProxySnapshot, received_at: Instant) -> Result<Self> {
        if snapshot.stale_after_ms == 0 || snapshot.stale_after_ms > MAX_SNAPSHOT_STALE_AFTER_MS {
            return Err(anyhow!("invalid HTTP proxy snapshot staleAfterMs"));
        }
        let remaining = absolute_snapshot_remaining(
            "HTTP proxy",
            snapshot.valid_until_ms,
            snapshot.stale_after_ms,
            now_ms(),
        )?;
        let deadline = received_at
            .checked_add(remaining)
            .context("HTTP proxy snapshot lease deadline overflow")?;
        let routes = snapshot
            .routes
            .into_iter()
            .map(|route| (route.hostname.clone(), route))
            .collect::<HashMap<_, _>>();
        let certs = snapshot
            .domain_pools
            .into_iter()
            .map(DomainCert::from_pool)
            .collect::<Result<Vec<_>>>()?;
        Ok(Self {
            generation: snapshot.generation,
            received_at,
            deadline,
            routes,
            certs,
        })
    }

    pub(crate) fn is_fresh(&self, now: Instant) -> bool {
        debug_assert!(self.deadline >= self.received_at);
        now < self.deadline
    }
}

#[derive(Clone, Debug)]
pub(crate) struct DomainCert {
    pub(crate) wildcard_domain: String,
    pub(crate) key: Arc<CertifiedKey>,
}

impl DomainCert {
    pub(crate) fn from_pool(pool: DomainPool) -> Result<Self> {
        if !is_valid_wildcard_domain(&pool.wildcard_domain) {
            return Err(anyhow!("invalid wildcard domain in HTTP TLS pool"));
        }
        let cert_pem = pool.certificate_pem.context("missing certificate")?;
        let key_pem = pool.private_key_pem.context("missing private key")?;
        let mut cert_reader = BufReader::new(cert_pem.as_bytes());
        let certs = rustls_pemfile::certs(&mut cert_reader)
            .collect::<std::result::Result<Vec<CertificateDer<'static>>, _>>()?;
        if certs.is_empty() {
            return Err(anyhow!("HTTP TLS pool contains no certificates"));
        }
        let mut key_reader = BufReader::new(key_pem.as_bytes());
        let key = rustls_pemfile::private_key(&mut key_reader)?
            .ok_or_else(|| anyhow!("missing private key"))?;
        let signing_key = rustls::crypto::ring::sign::any_supported_type(&key)?;
        let certified_key = CertifiedKey::new(certs, signing_key);
        certified_key
            .keys_match()
            .context("HTTP TLS certificate and private key do not match")?;
        Ok(Self {
            wildcard_domain: pool.wildcard_domain.to_ascii_lowercase(),
            key: Arc::new(certified_key),
        })
    }
}

#[derive(Debug)]
pub(crate) struct SnapshotCertResolver {
    pub(crate) store: Arc<SnapshotStore>,
}

impl ResolvesServerCert for SnapshotCertResolver {
    fn resolve(&self, hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        let sni = hello
            .server_name()?
            .trim_end_matches('.')
            .to_ascii_lowercase();
        let snapshot = self.store.load()?;
        snapshot
            .certs
            .iter()
            .find(|cert| hostname_matches_wildcard(&sni, &cert.wildcard_domain))
            .map(|cert| cert.key.clone())
    }
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct Route {
    #[serde(rename = "bindingId")]
    pub(crate) binding_id: String,
    pub(crate) hostname: String,
    #[serde(rename = "domainPoolId")]
    pub(crate) domain_pool_id: String,
    #[serde(rename = "routedIp")]
    pub(crate) routed_ip: String,
    #[serde(rename = "targetPort")]
    pub(crate) target_port: u16,
    #[serde(rename = "ownerId")]
    pub(crate) owner_id: String,
    #[serde(rename = "containerId")]
    pub(crate) container_id: String,
    #[serde(rename = "containerName")]
    #[allow(dead_code)]
    pub(crate) container_name: String,
    #[serde(rename = "instanceName")]
    pub(crate) instance_name: String,
    #[allow(dead_code)]
    pub(crate) status: String,
}

impl Route {
    pub(crate) fn same_authority(&self, other: &Self) -> bool {
        self.binding_id == other.binding_id
            && self.hostname == other.hostname
            && self.domain_pool_id == other.domain_pool_id
            && self.owner_id == other.owner_id
            && self.container_id == other.container_id
            && self.instance_name == other.instance_name
            && self.routed_ip == other.routed_ip
            && self.target_port == other.target_port
    }
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct DomainPool {
    #[serde(rename = "wildcardDomain")]
    pub(crate) wildcard_domain: String,
    #[serde(rename = "certificatePem")]
    pub(crate) certificate_pem: Option<String>,
    #[serde(rename = "privateKeyPem")]
    pub(crate) private_key_pem: Option<String>,
}

pub(crate) fn hostname_matches_wildcard(hostname: &str, wildcard: &str) -> bool {
    let wildcard = wildcard.trim_end_matches('.').to_ascii_lowercase();
    let suffix = wildcard.strip_prefix('*').unwrap_or(&wildcard);
    if !hostname.ends_with(suffix) {
        return false;
    }
    let prefix = &hostname[..hostname.len() - suffix.len()];
    !prefix.is_empty() && !prefix.contains('.')
}

pub(crate) fn is_valid_wildcard_domain(value: &str) -> bool {
    let Some(suffix) = value.strip_prefix("*.") else {
        return false;
    };
    !suffix.is_empty()
        && suffix.len() <= 253
        && suffix.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
}

#[cfg(test)]
#[path = "snapshot_tests.rs"]
mod tests;
