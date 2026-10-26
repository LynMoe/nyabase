use crate::bridge::{emit_audit, emit_metric, spawn_tcp_bridge};
use crate::config::ProxyConfig;
use crate::control::ControlPlane;
use crate::protocol::{SshProxyAuditEvent, TelemetrySender};
use crate::runtime::{lock, ConnectionRouteInfo, ConnectionState, MAX_CHANNELS_PER_CONNECTION};
use crate::snapshot::{RejectReason, RouteResolution, RoutingSnapshot, SnapshotStore};
use anyhow::{Context, Result};
use proxy_common::clock::now_ms;
use russh::keys::PublicKey;
use russh::server::{
    Auth, ChannelOpenHandle, Msg as ServerMsg, PublicKeyOffer, Session, VerifiedPublicKey,
};
use russh::{Channel, ChannelId, ChannelOpenFailure, Disconnect, Pty};
use std::net::SocketAddr;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tokio::net::TcpStream;
use tracing::{debug, info, warn};

pub(crate) const SSH_PROXY_PAUSE_REJECT_DESCRIPTION: &str = "Nyabase jump unavailable";

/// Longest SSH login the proxy accepts. A jump-format login is at most
/// `user.server.container` (3 × 64 + 2); this also matches the status
/// report's `login` bound in `@nyabase/common`.
pub(crate) const MAX_SSH_LOGIN_BYTES: usize = 256;

/// A login is stored, logged and reported, so anything other than short
/// printable ASCII is refused before any key lookup.
pub(crate) fn acceptable_login(login: &str) -> bool {
    !login.is_empty()
        && login.len() <= MAX_SSH_LOGIN_BYTES
        && login.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
}

pub(crate) struct ProxySshSession {
    pub(crate) store: Arc<SnapshotStore>,
    pub(crate) control: Arc<ControlPlane>,
    pub(crate) config: ProxyConfig,
    pub(crate) peer: SocketAddr,
    pub(crate) telemetry: TelemetrySender,
    pub(crate) connection: Arc<ConnectionState>,
    pub(crate) reject_paused: bool,
    pub(crate) authenticated_login: Option<String>,
    pub(crate) authenticated_public_key: Option<PublicKey>,
}

#[derive(Clone, Debug)]
pub(crate) struct OwnedResolvedRoute {
    pub(crate) user_id: String,
    pub(crate) username: String,
    pub(crate) server_id: String,
    pub(crate) server_slug: String,
    pub(crate) container_id: String,
    pub(crate) container_name: String,
    pub(crate) instance_name: String,
    pub(crate) routed_ip: String,
}

impl OwnedResolvedRoute {
    pub(crate) fn same_authority(&self, other: &Self) -> bool {
        self.user_id == other.user_id
            && self.username == other.username
            && self.server_id == other.server_id
            && self.server_slug == other.server_slug
            && self.container_id == other.container_id
            && self.container_name == other.container_name
            && self.instance_name == other.instance_name
            && self.routed_ip == other.routed_ip
    }
}

pub(crate) fn resolve_owned_route(
    snapshot: &RoutingSnapshot,
    login: &str,
) -> Result<OwnedResolvedRoute, RejectReason> {
    match snapshot.resolve_login(login) {
        RouteResolution::Accepted(route) => Ok(OwnedResolvedRoute {
            user_id: route.user.id.clone(),
            username: route.user.username.clone(),
            server_id: route.server.id.clone(),
            server_slug: route.server.slug.clone(),
            container_id: route.container.id.clone(),
            container_name: route.container.name.clone(),
            instance_name: route.route.instance_name.clone(),
            routed_ip: route.route.routed_ip.clone().unwrap_or_default(),
        }),
        RouteResolution::Rejected(reason) => Err(reason),
    }
}

impl ProxySshSession {
    pub(crate) fn new(
        store: Arc<SnapshotStore>,
        control: Arc<ControlPlane>,
        config: ProxyConfig,
        peer: SocketAddr,
        telemetry: TelemetrySender,
        connection: Arc<ConnectionState>,
        reject_paused: bool,
    ) -> Self {
        Self {
            store,
            control,
            config,
            peer,
            telemetry,
            connection,
            reject_paused,
            authenticated_login: None,
            authenticated_public_key: None,
        }
    }

    pub(crate) fn latest_snapshot(&self) -> Option<Arc<RoutingSnapshot>> {
        if !self.control.admit() {
            return None;
        }
        self.store.load().filter(|snapshot| snapshot.is_fresh())
    }

    pub(crate) fn held_snapshot(&self) -> Option<Arc<RoutingSnapshot>> {
        self.store.load()
    }

    pub(crate) fn pause_rejecting(&self) -> bool {
        self.reject_paused || !self.control.admit() && self.held_snapshot().is_some()
    }

    pub(crate) fn authorized_user_id(&self) -> Result<String> {
        let public_key = self
            .authenticated_public_key
            .as_ref()
            .context("SSH proxy session has no authenticated public key")?;
        let expected_user_id = lock(&self.connection.authenticated_user_id)
            .clone()
            .context("SSH proxy session has no authenticated user")?;
        let snapshot = self
            .held_snapshot()
            .context("no SSH proxy snapshot is installed")?;
        let user = snapshot
            .find_active_user_by_public_key(public_key)
            .map_err(|reason| anyhow::anyhow!(reason.to_string()))?;
        if user.id != expected_user_id {
            anyhow::bail!("SSH proxy user authorization changed");
        }
        Ok(user.id.clone())
    }

    /// `target` is the `direct-tcpip` host: a routed IP or a container name.
    pub(crate) fn authorized_route_for_target(&self, target: &str) -> Result<OwnedResolvedRoute> {
        let user_id = self.authorized_user_id()?;
        let snapshot = self
            .held_snapshot()
            .context("no SSH proxy snapshot is installed")?;
        snapshot
            .resolve_owned_route_for_user_target(&user_id, target)
            .map_err(|reason| anyhow::anyhow!(reason.to_string()))
    }

    /// `login` must already have passed [`acceptable_login`]; pass `None`
    /// for a login that did not, so its content never leaves the proxy.
    pub(crate) fn emit_login_audit(
        &self,
        login: Option<&str>,
        username: Option<&str>,
        route: Option<&OwnedResolvedRoute>,
        ok: bool,
        reason: Option<&str>,
    ) {
        emit_audit(
            &self.telemetry,
            SshProxyAuditEvent {
                user_id: route
                    .map(|route| route.user_id.clone())
                    .or_else(|| lock(&self.connection.authenticated_user_id).clone()),
                username: route
                    .map(|route| route.username.clone())
                    .or_else(|| username.map(str::to_string))
                    .or_else(|| login.map(str::to_string)),
                container_id: route.map(|route| route.container_id.clone()),
                server_id: route.map(|route| route.server_id.clone()),
                action: "login".to_string(),
                ok,
                reason: reason.map(ToOwned::to_owned),
                ts: now_ms(),
            },
        );
    }

    /// Counts and records one refused `direct-tcpip` channel.
    pub(crate) fn refuse_channel(
        &self,
        result: &'static str,
        target: (&str, u32),
        originator: &str,
        route: Option<&OwnedResolvedRoute>,
    ) {
        emit_metric(
            &self.telemetry,
            "ssh_proxy_channels_total",
            vec![
                ("kind", "direct_tcpip".to_string()),
                ("result", result.to_string()),
            ],
            1.0,
        );
        self.connection.reject_channel(
            result,
            target.0,
            target.1,
            originator,
            route.map(ConnectionRouteInfo::from).as_ref(),
        );
    }

    /// Counts a refused request that is not a `direct-tcpip` channel.
    pub(crate) fn refuse_request(&self, kind: &'static str) {
        self.connection.count_rejected_request(kind);
    }
}

impl ProxySshSession {
    /// The key a client offers before proving it holds it (`auth_publickey_offered`).
    pub(crate) async fn auth_offered_key(
        &mut self,
        user: &str,
        public_key: &PublicKey,
    ) -> Result<Auth, anyhow::Error> {
        if !acceptable_login(user) {
            self.connection.note_auth_failure("invalid_login");
            return Ok(Auth::reject());
        }
        if self.pause_rejecting() {
            return Ok(Auth::Accept);
        }
        let Some(snapshot) = self.latest_snapshot() else {
            self.connection.note_auth_failure("snapshot_unavailable");
            return Ok(Auth::reject());
        };
        if snapshot.public_key_allowed(user, public_key) {
            Ok(Auth::Accept)
        } else {
            self.connection.note_auth_failure("public_key_rejected");
            Ok(Auth::reject())
        }
    }

    /// A key the client proved it holds (`auth_publickey`).
    pub(crate) async fn auth_verified_key(
        &mut self,
        user: &str,
        public_key: &PublicKey,
    ) -> Result<Auth, anyhow::Error> {
        if !acceptable_login(user) {
            warn!(
                peer = %self.peer,
                login_bytes = user.len(),
                "SSH proxy login rejected: not 1..=256 printable ASCII bytes"
            );
            self.emit_login_audit(None, None, None, false, Some("invalid_login"));
            self.connection.note_auth_failure("invalid_login");
            return Ok(Auth::reject());
        }
        if self.pause_rejecting() {
            return Ok(Auth::Accept);
        }
        let Some(snapshot) = self.latest_snapshot() else {
            self.emit_login_audit(Some(user), None, None, false, Some("snapshot_unavailable"));
            self.connection.note_auth_failure("snapshot_unavailable");
            return Ok(Auth::reject());
        };
        let user_row = match snapshot.find_active_user_by_public_key(public_key) {
            Ok(user_row) => user_row,
            Err(reason) => {
                warn!(peer = %self.peer, login = user, %reason, "SSH proxy public key rejected");
                self.emit_login_audit(Some(user), None, None, false, Some(reason.code()));
                self.connection.note_auth_failure(reason.code());
                return Ok(Auth::reject());
            }
        };
        // Prefer a jump-format login that resolves to a container owned by the
        // key holder; otherwise accept any SSH username and bind the route later
        // on direct-tcpip using the target IP.
        let pinned_route = resolve_owned_route(&snapshot, user)
            .ok()
            .filter(|route| route.user_id == user_row.id);
        info!(
            peer = %self.peer,
            login = user,
            username = %user_row.username,
            container_id = pinned_route
                .as_ref()
                .map(|route| route.container_id.as_str())
                .unwrap_or("-"),
            "SSH proxy login authenticated"
        );
        self.emit_login_audit(
            Some(user),
            Some(&user_row.username),
            pinned_route.as_ref(),
            true,
            None,
        );
        self.connection.set_authenticated(
            user,
            public_key,
            &user_row.id,
            &user_row.username,
            pinned_route.as_ref(),
        );
        emit_metric(
            &self.telemetry,
            "ssh_proxy_logins_total",
            vec![
                ("result", "accepted".to_string()),
                (
                    "server_slug",
                    pinned_route
                        .as_ref()
                        .map(|route| route.server_slug.clone())
                        .unwrap_or_else(|| "unbound".to_string()),
                ),
            ],
            1.0,
        );
        self.authenticated_login = Some(user.to_string());
        self.authenticated_public_key = Some(public_key.clone());
        Ok(Auth::Accept)
    }
}

impl russh::server::Handler for ProxySshSession {
    type Error = anyhow::Error;

    async fn auth_succeeded(&mut self, session: &mut Session) -> Result<(), Self::Error> {
        if self.pause_rejecting() {
            self.connection.note_auth_failure("paused");
            session.disconnect(
                Disconnect::ServiceNotAvailable,
                SSH_PROXY_PAUSE_REJECT_DESCRIPTION,
                "en",
            )?;
            return Ok(());
        }
        let current = self.held_snapshot();
        if !self.connection.authorization_matches(current.as_deref()) {
            self.connection.set_close_reason("revoked");
            anyhow::bail!("SSH proxy authorization changed during authentication");
        }
        self.connection.note_client_version(session.remote_sshid());
        self.connection.report_opened();
        Ok(())
    }

    async fn auth_none(&mut self, _user: &str) -> Result<Auth, Self::Error> {
        Ok(Auth::reject())
    }

    async fn auth_password(&mut self, _user: &str, _password: &str) -> Result<Auth, Self::Error> {
        Ok(Auth::reject())
    }

    async fn auth_publickey_offered(
        &mut self,
        user: &str,
        offer: PublicKeyOffer<'_>,
    ) -> Result<Auth, Self::Error> {
        self.auth_offered_key(user, offer.public_key).await
    }

    async fn auth_publickey(
        &mut self,
        user: &str,
        key: VerifiedPublicKey<'_>,
    ) -> Result<Auth, Self::Error> {
        self.auth_verified_key(user, key.public_key).await
    }

    async fn channel_open_session(
        &mut self,
        _channel: Channel<ServerMsg>,
        reply: ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        if self.pause_rejecting() {
            reply
                .reject(ChannelOpenFailure::AdministrativelyProhibited)
                .await;
            return Ok(());
        }
        self.refuse_request("session");
        emit_metric(
            &self.telemetry,
            "ssh_proxy_channels_total",
            vec![
                ("kind", "session".to_string()),
                ("result", "rejected".to_string()),
            ],
            1.0,
        );
        reply
            .reject(ChannelOpenFailure::AdministrativelyProhibited)
            .await;
        Ok(())
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _term: &str,
        _col_width: u32,
        _row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _modes: &[(Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_failure(channel)?;
        Ok(())
    }

    async fn env_request(
        &mut self,
        channel: ChannelId,
        _variable_name: &str,
        _variable_value: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_failure(channel)?;
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_failure(channel)?;
        Ok(())
    }

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        _data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_failure(channel)?;
        Ok(())
    }

    async fn subsystem_request(
        &mut self,
        channel: ChannelId,
        _name: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_failure(channel)?;
        Ok(())
    }

    async fn window_change_request(
        &mut self,
        _channel: ChannelId,
        _col_width: u32,
        _row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        Ok(())
    }

    async fn agent_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<bool, Self::Error> {
        session.channel_failure(channel)?;
        Ok(false)
    }

    async fn data(
        &mut self,
        _channel: ChannelId,
        _data: &[u8],
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        Ok(())
    }

    async fn extended_data(
        &mut self,
        _channel: ChannelId,
        _code: u32,
        _data: &[u8],
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        Ok(())
    }

    async fn channel_eof(
        &mut self,
        _channel: ChannelId,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        Ok(())
    }

    async fn channel_close(
        &mut self,
        _channel: ChannelId,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        Ok(())
    }

    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<ServerMsg>,
        host_to_connect: &str,
        port_to_connect: u32,
        originator_address: &str,
        originator_port: u32,
        reply: ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        let peer = self.peer;
        let target = (host_to_connect, port_to_connect);
        let originator = format!("{originator_address}:{originator_port}");
        if self.pause_rejecting() {
            self.refuse_channel("rejected_paused", target, &originator, None);
            reply
                .reject(ChannelOpenFailure::AdministrativelyProhibited)
                .await;
            return Ok(());
        }
        if port_to_connect != 22 {
            warn!(
                %peer,
                target = %format!("{host_to_connect}:{port_to_connect}"),
                "direct-tcpip target outside PermitOpen"
            );
            self.refuse_channel("rejected_permit", target, &originator, None);
            reply
                .reject(ChannelOpenFailure::AdministrativelyProhibited)
                .await;
            return Ok(());
        }

        let route = match self.authorized_route_for_target(host_to_connect) {
            Ok(route) => route,
            Err(error) => {
                warn!(%peer, %error, target = %host_to_connect, "direct-tcpip rejected: unauthorized");
                self.refuse_channel("rejected_unauthorized", target, &originator, None);
                reply
                    .reject(ChannelOpenFailure::AdministrativelyProhibited)
                    .await;
                return Ok(());
            }
        };
        if self.connection.channels.load(Ordering::Relaxed) >= MAX_CHANNELS_PER_CONNECTION {
            warn!(%peer, "SSH direct-tcpip channel limit reached");
            self.refuse_channel("rejected_limit", target, &originator, Some(&route));
            reply.reject(ChannelOpenFailure::ResourceShortage).await;
            return Ok(());
        }

        let Some(bridge_permit) = self.connection.try_reserve_child_task() else {
            warn!(%peer, "SSH direct-tcpip child task limit reached");
            self.refuse_channel("rejected_child_limit", target, &originator, Some(&route));
            reply.reject(ChannelOpenFailure::ResourceShortage).await;
            return Ok(());
        };

        let address = format!("{}:22", route.routed_ip);
        let stream = match tokio::time::timeout(
            self.config.route_connect_timeout,
            TcpStream::connect(&address),
        )
        .await
        {
            Ok(Ok(stream)) => stream,
            Ok(Err(error)) => {
                warn!(%peer, target = %address, %originator, %error, "direct-tcpip TCP connect failed");
                self.refuse_channel("connect_failed", target, &originator, Some(&route));
                reply.reject(ChannelOpenFailure::ConnectFailed).await;
                return Ok(());
            }
            Err(_) => {
                warn!(%peer, target = %address, %originator, "direct-tcpip TCP connect timed out");
                self.refuse_channel("connect_timeout", target, &originator, Some(&route));
                reply.reject(ChannelOpenFailure::ConnectFailed).await;
                return Ok(());
            }
        };

        // Bind first, re-check second: a snapshot installed after this point
        // revalidates the bound route and aborts this bridge on its own.
        bridge_permit.bind_route(&route);
        // A failed re-check (user or key revoked meanwhile) refuses this
        // channel only; the connection's own revalidation handles the rest.
        if !self
            .authorized_route_for_target(&route.routed_ip)
            .is_ok_and(|current| current.same_authority(&route))
        {
            warn!(
                %peer,
                target = %address,
                "direct-tcpip rejected: route authorization changed during connect"
            );
            self.refuse_channel("rejected_revoked", target, &originator, Some(&route));
            reply
                .reject(ChannelOpenFailure::AdministrativelyProhibited)
                .await;
            return Ok(());
        }

        emit_metric(
            &self.telemetry,
            "ssh_proxy_channels_total",
            vec![
                ("kind", "direct_tcpip".to_string()),
                ("result", "opened".to_string()),
            ],
            1.0,
        );
        self.connection.set_display_route(&route);
        debug!(
            %peer,
            target = %address,
            %originator,
            container_id = %route.container_id,
            "opened direct-tcpip TCP bridge"
        );
        let history = self.connection.open_channel(
            host_to_connect,
            port_to_connect,
            &originator,
            ConnectionRouteInfo::from(&route),
        );
        // Confirm before the bridge can write: the reply goes out ahead of channel data.
        reply.accept().await;
        spawn_tcp_bridge(
            bridge_permit,
            peer,
            channel,
            stream,
            self.connection.clone(),
            history,
        );
        Ok(())
    }

    async fn tcpip_forward(
        &mut self,
        address: &str,
        _port: &mut u32,
        _session: &mut Session,
    ) -> Result<bool, Self::Error> {
        warn!(
            peer = %self.peer,
            %address,
            "SSH remote tcpip forward rejected in jump-host mode"
        );
        self.refuse_request("remote_forward");
        emit_metric(
            &self.telemetry,
            "ssh_proxy_forwards_total",
            vec![
                ("kind", "remote_tcpip".to_string()),
                ("result", "rejected".to_string()),
            ],
            1.0,
        );
        Ok(false)
    }

    async fn cancel_tcpip_forward(
        &mut self,
        address: &str,
        port: u32,
        _session: &mut Session,
    ) -> Result<bool, Self::Error> {
        warn!(
            peer = %self.peer,
            %address,
            port,
            "SSH cancel tcpip forward rejected in jump-host mode"
        );
        self.refuse_request("cancel_remote_forward");
        emit_metric(
            &self.telemetry,
            "ssh_proxy_forwards_total",
            vec![
                ("kind", "remote_tcpip".to_string()),
                ("result", "rejected".to_string()),
            ],
            1.0,
        );
        Ok(false)
    }

    async fn channel_open_direct_streamlocal(
        &mut self,
        _channel: Channel<ServerMsg>,
        _socket_path: &str,
        reply: ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.refuse_request("direct_streamlocal");
        reply
            .reject(ChannelOpenFailure::AdministrativelyProhibited)
            .await;
        Ok(())
    }

    async fn streamlocal_forward(
        &mut self,
        _socket_path: &str,
        _session: &mut Session,
    ) -> Result<bool, Self::Error> {
        self.refuse_request("remote_streamlocal_forward");
        Ok(false)
    }
}

#[cfg(test)]
#[path = "session_tests.rs"]
mod tests;
