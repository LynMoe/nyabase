use crate::protocol::{
    ProxyContainer, ProxyImage, ProxyRoute, ProxyServer, ProxySnapshot, ProxyUser,
};
use crate::runtime::lock;
use crate::session::OwnedResolvedRoute;
use anyhow::{Context, Result};
use arc_swap::ArcSwapOption;
use proxy_common::clock::{absolute_snapshot_remaining, now_ms};
use russh::keys::ssh_key::public::KeyData;
use russh::keys::{decode_secret_key, parse_public_key_base64, PrivateKey, PublicKey};
use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use thiserror::Error;
use tokio::sync::watch;
use tracing::{debug, info};

pub(crate) struct SnapshotStore {
    pub(crate) current: ArcSwapOption<RoutingSnapshot>,
    pub(crate) write_lock: Mutex<()>,
    pub(crate) changes: watch::Sender<u64>,
}

impl Default for SnapshotStore {
    fn default() -> Self {
        let (changes, _) = watch::channel(0);
        Self {
            current: ArcSwapOption::empty(),
            write_lock: Mutex::new(()),
            changes,
        }
    }
}

impl SnapshotStore {
    pub(crate) fn store(&self, snapshot: ProxySnapshot, epoch: u64) -> Result<bool> {
        let generation = snapshot.generation;
        let routing = RoutingSnapshot::from_snapshot_in_epoch(snapshot, epoch)?;
        let _write = lock(&self.write_lock);
        if self.load().is_some_and(|current| {
            epoch < current.epoch || (epoch == current.epoch && generation <= current.generation)
        }) {
            debug!(
                epoch,
                generation, "ignored non-increasing SSH proxy snapshot"
            );
            return Ok(false);
        }
        let route_count = routing.routes_by_container_id.len();
        self.current.store(Some(Arc::new(routing)));
        drop(_write);
        self.signal_change();
        info!(
            epoch,
            generation, route_count, "installed SSH proxy snapshot"
        );
        Ok(true)
    }

    pub(crate) fn load(&self) -> Option<Arc<RoutingSnapshot>> {
        self.current.load_full()
    }

    pub(crate) fn clear(&self) {
        let _write = lock(&self.write_lock);
        self.current.store(None);
        drop(_write);
        self.signal_change();
    }

    pub(crate) fn current_lease(&self) -> Option<(u64, Instant)> {
        self.load()
            .map(|snapshot| (snapshot.generation, snapshot.deadline))
    }

    pub(crate) fn expire(&self, generation: u64, deadline: Instant) -> bool {
        let _write = lock(&self.write_lock);
        let should_expire = self.current.load_full().is_some_and(|current| {
            current.generation == generation && current.deadline == deadline && !current.is_fresh()
        });
        if should_expire {
            self.current.store(None);
        }
        drop(_write);
        if should_expire {
            self.signal_change();
        }
        should_expire
    }

    pub(crate) fn subscribe(&self) -> watch::Receiver<u64> {
        self.changes.subscribe()
    }

    pub(crate) fn signal_change(&self) {
        self.changes
            .send_modify(|revision| *revision = revision.wrapping_add(1));
    }
}

#[derive(Clone, Debug)]
#[allow(dead_code)]
pub(crate) struct RoutingSnapshot {
    pub(crate) epoch: u64,
    pub(crate) generation: u64,
    pub(crate) deadline: Instant,
    pub(crate) host_private_key: PrivateKey,
    pub(crate) users: Vec<RoutingUser>,
    /// Active users by the key data of each authorized key (comments ignored).
    pub(crate) active_users_by_key: HashMap<KeyData, Vec<usize>>,
    /// Lower-cased hostname suffix (`nya` for `work.nya`); empty accepts bare names only.
    pub(crate) host_suffix: String,
    pub(crate) servers_by_id: HashMap<String, ProxyServer>,
    pub(crate) images_by_id: HashMap<String, ProxyImage>,
    pub(crate) containers: Vec<ProxyContainer>,
    pub(crate) routes_by_container_id: HashMap<String, ProxyRoute>,
}

#[derive(Clone, Debug)]
pub(crate) struct RoutingUser {
    pub(crate) id: String,
    pub(crate) username: String,
    pub(crate) status: String,
    pub(crate) public_keys: Vec<String>,
}

impl RoutingUser {
    pub(crate) fn from_proxy(user: ProxyUser) -> Self {
        Self {
            id: user.id,
            username: user.username,
            status: user.status,
            public_keys: user.public_keys,
        }
    }
}

impl RoutingSnapshot {
    #[cfg(test)]
    pub(crate) fn from_snapshot(snapshot: ProxySnapshot) -> Result<Self> {
        Self::from_snapshot_in_epoch(snapshot, 0)
    }

    pub(crate) fn from_snapshot_in_epoch(snapshot: ProxySnapshot, epoch: u64) -> Result<Self> {
        let remaining = absolute_snapshot_remaining(
            "SSH proxy",
            snapshot.valid_until,
            snapshot.stale_after_ms,
            now_ms(),
        )?;
        let deadline = Instant::now()
            .checked_add(remaining)
            .context("SSH proxy snapshot lease deadline overflow")?;
        let host_private_key = decode_secret_key(&snapshot.host_key.private_key, None)
            .context("failed to parse SSH proxy host private key")?;
        let users = snapshot
            .users
            .into_iter()
            .map(RoutingUser::from_proxy)
            .collect::<Vec<_>>();
        let mut active_users_by_key: HashMap<KeyData, Vec<usize>> = HashMap::new();
        for (index, user) in users.iter().enumerate() {
            if user.status != "active" {
                continue;
            }
            for key in &user.public_keys {
                if let Some(parsed) = parse_authorized_key(key) {
                    let holders = active_users_by_key
                        .entry(parsed.key_data().clone())
                        .or_default();
                    if !holders.contains(&index) {
                        holders.push(index);
                    }
                }
            }
        }
        Ok(Self {
            epoch,
            generation: snapshot.generation,
            deadline,
            host_private_key,
            users,
            active_users_by_key,
            host_suffix: snapshot.host_suffix.trim_matches('.').to_ascii_lowercase(),
            servers_by_id: snapshot
                .servers
                .into_iter()
                .map(|server| (server.id.clone(), server))
                .collect(),
            images_by_id: snapshot
                .images
                .into_iter()
                .map(|image| (image.id.clone(), image))
                .collect(),
            containers: snapshot.containers,
            routes_by_container_id: snapshot
                .routes
                .into_iter()
                .map(|route| (route.container_id.clone(), route))
                .collect(),
        })
    }

    pub(crate) fn is_fresh(&self) -> bool {
        Instant::now() < self.deadline
    }

    pub(crate) fn resolve_login(&self, login: &str) -> RouteResolution<'_> {
        let parsed = match ParsedLogin::parse(login) {
            Some(parsed) => parsed,
            None => return RouteResolution::Rejected(RejectReason::InvalidLogin),
        };

        let user = match self
            .users
            .iter()
            .find(|user| user.username.eq_ignore_ascii_case(&parsed.username))
        {
            Some(user) if user.status == "active" => user,
            Some(_) => return RouteResolution::Rejected(RejectReason::UserDisabled),
            None => return RouteResolution::Rejected(RejectReason::UserNotFound),
        };

        if let Some(server_slug) = &parsed.server_slug {
            let exists = self
                .servers_by_id
                .values()
                .any(|server| server.slug.eq_ignore_ascii_case(server_slug));
            if !exists {
                return RouteResolution::Rejected(RejectReason::ServerNotFound);
            }
        }

        let mut candidates = Vec::new();
        for container in &self.containers {
            if container.owner_id != user.id {
                continue;
            }
            if !container.name.eq_ignore_ascii_case(&parsed.container_name) {
                continue;
            }
            if !self
                .images_by_id
                .get(&container.image_id)
                .map(|image| image.ssh_enabled)
                .unwrap_or(false)
            {
                continue;
            }
            let Some(server) = self.servers_by_id.get(&container.server_id) else {
                continue;
            };
            if !server.status.eq_ignore_ascii_case("online") {
                continue;
            }
            if let Some(server_slug) = &parsed.server_slug {
                if !server.slug.eq_ignore_ascii_case(server_slug) {
                    continue;
                }
            }
            let Some(route) = self.routes_by_container_id.get(&container.id) else {
                continue;
            };
            if route.server_id != container.server_id {
                continue;
            }
            if route.instance_name != container.instance_name {
                continue;
            }
            if !route.is_active() {
                continue;
            }
            candidates.push(ResolvedRoute {
                login: parsed.clone(),
                user,
                server,
                container,
                route,
            });
        }

        match candidates.len() {
            0 => RouteResolution::Rejected(RejectReason::RouteNotFound),
            1 => RouteResolution::Accepted(candidates.remove(0)),
            _ => RouteResolution::Rejected(RejectReason::AmbiguousContainer),
        }
    }

    pub(crate) fn public_key_allowed(&self, _login: &str, public_key: &PublicKey) -> bool {
        self.find_active_user_by_public_key(public_key).is_ok()
    }

    pub(crate) fn find_active_user_by_public_key<'a>(
        &'a self,
        public_key: &PublicKey,
    ) -> Result<&'a RoutingUser, RejectReason> {
        match self
            .active_users_by_key
            .get(public_key.key_data())
            .map(Vec::as_slice)
        {
            None | Some([]) => Err(RejectReason::PublicKeyRejected),
            Some([index]) => Ok(&self.users[*index]),
            Some(_) => Err(RejectReason::AmbiguousUser),
        }
    }

    /// Resolves a `direct-tcpip` target: a routed IPv4 address, or one of the
    /// user's container names, bare (`work`) or with the host suffix
    /// (`work.nya`). Name lookup never crosses owners.
    pub(crate) fn resolve_owned_route_for_user_target(
        &self,
        user_id: &str,
        target: &str,
    ) -> Result<OwnedResolvedRoute, RejectReason> {
        if target.parse::<Ipv4Addr>().is_ok() {
            return self.resolve_owned_route_for_user_ip(user_id, target);
        }
        let name = self
            .container_name_for_host(target)
            .ok_or(RejectReason::InvalidTarget)?;
        let mut resolved = self
            .containers
            .iter()
            .filter(|container| {
                container.owner_id == user_id && container.name.eq_ignore_ascii_case(&name)
            })
            .filter_map(|container| self.routes_by_container_id.get(&container.id))
            .filter_map(|route| route.routed_ip.as_deref())
            .filter_map(|address| self.resolve_owned_route_for_user_ip(user_id, address).ok())
            .filter(|route| route.container_name.eq_ignore_ascii_case(&name));
        let Some(route) = resolved.next() else {
            return Err(RejectReason::RouteNotFound);
        };
        if resolved.next().is_some() {
            return Err(RejectReason::AmbiguousContainer);
        }
        Ok(route)
    }

    /// The container name a hostname target names, or `None` for anything
    /// that is not one DNS label, optionally followed by the host suffix.
    pub(crate) fn container_name_for_host(&self, target: &str) -> Option<String> {
        let host = target.trim_end_matches('.').to_ascii_lowercase();
        let label = if self.host_suffix.is_empty() {
            host.as_str()
        } else {
            host.strip_suffix(self.host_suffix.as_str())
                .and_then(|rest| rest.strip_suffix('.'))
                .unwrap_or(host.as_str())
        };
        let valid = (1..=63).contains(&label.len())
            && label
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            && label.as_bytes()[0].is_ascii_alphanumeric();
        valid.then(|| label.to_string())
    }

    pub(crate) fn resolve_owned_route_for_user_ip(
        &self,
        user_id: &str,
        routed_ip: &str,
    ) -> Result<OwnedResolvedRoute, RejectReason> {
        let mut candidates = Vec::new();
        for container in &self.containers {
            if container.owner_id != user_id {
                continue;
            }
            if !self
                .images_by_id
                .get(&container.image_id)
                .map(|image| image.ssh_enabled)
                .unwrap_or(false)
            {
                continue;
            }
            let Some(server) = self.servers_by_id.get(&container.server_id) else {
                continue;
            };
            if !server.status.eq_ignore_ascii_case("online") {
                continue;
            }
            let Some(route) = self.routes_by_container_id.get(&container.id) else {
                continue;
            };
            if route.server_id != container.server_id {
                continue;
            }
            if route.instance_name != container.instance_name {
                continue;
            }
            if !route.is_active() {
                continue;
            }
            let Some(ip) = route.routed_ip.as_deref() else {
                continue;
            };
            if ip != routed_ip {
                continue;
            }
            candidates.push(OwnedResolvedRoute {
                user_id: user_id.to_string(),
                username: self
                    .users
                    .iter()
                    .find(|user| user.id == user_id)
                    .map(|user| user.username.clone())
                    .unwrap_or_default(),
                server_id: server.id.clone(),
                server_slug: server.slug.clone(),
                container_id: container.id.clone(),
                container_name: container.name.clone(),
                instance_name: route.instance_name.clone(),
                routed_ip: ip.to_string(),
            });
        }
        match candidates.len() {
            0 => Err(RejectReason::RouteNotFound),
            1 => Ok(candidates.remove(0)),
            _ => Err(RejectReason::AmbiguousContainer),
        }
    }
}

impl ProxyRoute {
    pub(crate) fn is_active(&self) -> bool {
        !self.instance_name.is_empty()
            && self
                .routed_ip
                .as_deref()
                .is_some_and(is_routable_container_ipv4)
            && self.status.eq_ignore_ascii_case("running")
            && self.ssh_status == "running"
    }
}

pub(crate) fn is_routable_container_ipv4(value: &str) -> bool {
    value.parse::<Ipv4Addr>().is_ok_and(|address| {
        !address.is_unspecified()
            && !address.is_loopback()
            && !address.is_multicast()
            && address != Ipv4Addr::BROADCAST
    })
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ParsedLogin {
    pub(crate) username: String,
    pub(crate) server_slug: Option<String>,
    pub(crate) container_name: String,
}

impl ParsedLogin {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        let parts = value
            .trim()
            .to_lowercase()
            .split('.')
            .filter(|part| !part.is_empty())
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();
        match parts.as_slice() {
            [username, container_name] => Some(Self {
                username: username.clone(),
                server_slug: None,
                container_name: container_name.clone(),
            }),
            [username, server_slug, container_name] => Some(Self {
                username: username.clone(),
                server_slug: Some(server_slug.clone()),
                container_name: container_name.clone(),
            }),
            _ => None,
        }
    }
}

#[derive(Debug)]
#[allow(dead_code)]
pub(crate) struct ResolvedRoute<'a> {
    pub(crate) login: ParsedLogin,
    pub(crate) user: &'a RoutingUser,
    pub(crate) server: &'a ProxyServer,
    pub(crate) container: &'a ProxyContainer,
    pub(crate) route: &'a ProxyRoute,
}

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
pub(crate) enum RejectReason {
    #[error("invalid login")]
    InvalidLogin,
    #[error("user not found")]
    UserNotFound,
    #[error("user disabled")]
    UserDisabled,
    #[error("server not found")]
    ServerNotFound,
    #[error("route not found")]
    RouteNotFound,
    #[error("ambiguous container")]
    AmbiguousContainer,
    #[error("public key rejected")]
    PublicKeyRejected,
    #[error("ambiguous user")]
    AmbiguousUser,
    #[error("invalid target")]
    InvalidTarget,
}

impl RejectReason {
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::InvalidLogin => "invalid_login",
            Self::UserNotFound => "user_not_found",
            Self::UserDisabled => "user_disabled",
            Self::ServerNotFound => "server_not_found",
            Self::RouteNotFound => "route_not_found",
            Self::AmbiguousContainer => "ambiguous_container",
            Self::PublicKeyRejected => "public_key_rejected",
            Self::AmbiguousUser => "ambiguous_user",
            Self::InvalidTarget => "invalid_target",
        }
    }
}

#[derive(Debug)]
pub(crate) enum RouteResolution<'a> {
    Accepted(ResolvedRoute<'a>),
    Rejected(RejectReason),
}

pub(crate) fn parse_authorized_key(text: &str) -> Option<PublicKey> {
    text.split_whitespace()
        .find_map(|part| parse_public_key_base64(part).ok())
}

#[cfg(test)]
#[path = "snapshot_tests.rs"]
mod tests;
