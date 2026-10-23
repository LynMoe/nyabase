use crate::config::ProxyConfig;
use crate::control::ControlPlane;
use crate::protocol::{
    ProxyContainer, ProxyHostKey, ProxyImage, ProxyRoute, ProxyServer, ProxySnapshot, ProxyUser,
};
use crate::snapshot::{RoutingSnapshot, SnapshotStore};
use anyhow::Result;
use futures_util::Sink;
use proxy_common::clock::now_ms;
use std::sync::Arc;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

pub(crate) const ALICE_KEY: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILM+rvN+ot98qgEN796jTiQfZfG1KaT0PtFDJ/XFSqti alice@example";

pub(crate) const OTHER_KEY: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ other@example";

pub(crate) const TEST_PRIVATE_KEY: &str = concat!(
    "-----BEGIN OPENSSH PRIVATE KEY-----\n",
    "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n",
    "QyNTUxOQAAACDjj8cE23hVwPTrRtCZZRK9nZcMNpjnRJdbLWeT9+XbeQAAAJh+dobffnaG\n",
    "3wAAAAtzc2gtZWQyNTUxOQAAACDjj8cE23hVwPTrRtCZZRK9nZcMNpjnRJdbLWeT9+XbeQ\n",
    "AAAEDKCliCKTTTtnNjAxywhC+fnOBrbIGRs5FEf9LyBg0InOOPxwTbeFXA9OtG0JllEr2d\n",
    "lww2mOdEl1stZ5P35dt5AAAAEW55YWJhc2UtdGVzdC1vbmx5AQIDBA==\n",
    "-----END OPENSSH PRIVATE KEY-----\n",
);

pub(crate) fn fixture_snapshot() -> RoutingSnapshot {
    RoutingSnapshot::from_snapshot(fixture_proxy_snapshot(7)).unwrap()
}

pub(crate) fn fixture_proxy_snapshot(generation: u64) -> ProxySnapshot {
    ProxySnapshot {
        generation,
        stale_after_ms: 300_000,
        valid_until: now_ms() + 300_000,
        host_key: ProxyHostKey {
            private_key: TEST_PRIVATE_KEY.to_string(),
            public_key: "ssh-ed25519 HOST".to_string(),
            fingerprint: "SHA256:host".to_string(),
            generation: 1,
        },
        host_suffix: "nya".to_string(),
        users: vec![
            ProxyUser {
                id: "user-a".to_string(),
                username: "alice".to_string(),
                status: "active".to_string(),
                public_keys: vec![ALICE_KEY.to_string()],
            },
            ProxyUser {
                id: "user-b".to_string(),
                username: "disabled".to_string(),
                status: "disabled".to_string(),
                public_keys: vec![],
            },
        ],
        servers: vec![
            ProxyServer {
                id: "server-a".to_string(),
                slug: "cpu-a".to_string(),
                name: "CPU A".to_string(),
                status: "online".to_string(),
            },
            ProxyServer {
                id: "server-b".to_string(),
                slug: "cpu-b".to_string(),
                name: "CPU B".to_string(),
                status: "online".to_string(),
            },
        ],
        images: vec![
            ProxyImage {
                id: "image-a".to_string(),
                ssh_enabled: true,
            },
            ProxyImage {
                id: "image-b".to_string(),
                ssh_enabled: false,
            },
        ],
        containers: vec![
            container(
                "container-a",
                "user-a",
                "server-a",
                "image-a",
                "work",
                "runtime-a",
            ),
            container(
                "container-b",
                "user-a",
                "server-b",
                "image-a",
                "work",
                "runtime-b",
            ),
            container(
                "container-c",
                "user-a",
                "server-a",
                "image-a",
                "solo",
                "runtime-c",
            ),
            container(
                "container-d",
                "user-a",
                "server-a",
                "image-b",
                "gpu",
                "runtime-d",
            ),
            container(
                "container-e",
                "user-a",
                "server-a",
                "image-a",
                "sleeping",
                "runtime-e",
            ),
            container(
                "container-f",
                "user-b",
                "server-a",
                "image-a",
                "solo",
                "runtime-f",
            ),
        ],
        routes: vec![
            route(
                "container-a",
                "server-a",
                "runtime-a",
                Some("10.0.0.2"),
                "running",
                "running",
            ),
            route(
                "container-b",
                "server-b",
                "runtime-b",
                Some("10.0.0.3"),
                "running",
                "running",
            ),
            route(
                "container-c",
                "server-a",
                "runtime-c",
                Some("10.0.0.4"),
                "running",
                "running",
            ),
            route(
                "container-d",
                "server-a",
                "runtime-d",
                Some("10.0.0.5"),
                "running",
                "running",
            ),
            route(
                "container-e",
                "server-a",
                "runtime-e",
                Some("10.0.0.6"),
                "stopped",
                "container_stopped",
            ),
            route(
                "container-f",
                "server-a",
                "runtime-f",
                Some("10.0.0.7"),
                "running",
                "running",
            ),
        ],
    }
}

pub(crate) fn container(
    id: &str,
    owner_id: &str,
    server_id: &str,
    image_id: &str,
    name: &str,
    instance_name: &str,
) -> ProxyContainer {
    ProxyContainer {
        id: id.to_string(),
        owner_id: owner_id.to_string(),
        server_id: server_id.to_string(),
        image_id: image_id.to_string(),
        name: name.to_string(),
        instance_name: instance_name.to_string(),
    }
}

pub(crate) fn route(
    container_id: &str,
    server_id: &str,
    instance_name: &str,
    routed_ip: Option<&str>,
    status: &str,
    ssh_status: &str,
) -> ProxyRoute {
    ProxyRoute {
        container_id: container_id.to_string(),
        server_id: server_id.to_string(),
        instance_name: instance_name.to_string(),
        routed_ip: routed_ip.map(ToOwned::to_owned),
        status: status.to_string(),
        ssh_status: ssh_status.to_string(),
        observed_at: "2026-06-08T00:00:00.000Z".to_string(),
    }
}

pub(crate) fn test_config() -> ProxyConfig {
    ProxyConfig {
        backend_ws: "ws://backend.invalid".to_string(),
        backend_tls: None,
        token: "a".repeat(32),
        listen: "127.0.0.1:2222".to_string(),
        max_connections: 8,
        max_connections_per_ip: 8,
        max_connections_per_ipv6_48: 8,
        max_preauth_connections: 8,
        auth_timeout: Duration::from_secs(30),
        reconnect_delay: Duration::from_secs(1),
        route_connect_timeout: Duration::from_secs(1),
        status_interval: Duration::from_secs(1),
        control_hold: Duration::from_secs(300),
        control_liveness: Default::default(),
    }
}

pub(crate) fn paused_plane(store: &SnapshotStore) -> Arc<ControlPlane> {
    let control = Arc::new(ControlPlane::new());
    control.begin_epoch();
    assert!(store
        .store(fixture_proxy_snapshot(7), control.epoch())
        .unwrap());
    control.resume_authoritative();
    assert!(control.pause(Duration::from_secs(300)));
    control
}
pub(crate) struct NeverReadySink;

impl Sink<Message> for NeverReadySink {
    type Error = std::io::Error;

    fn poll_ready(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), Self::Error>> {
        std::task::Poll::Pending
    }

    fn start_send(self: std::pin::Pin<&mut Self>, _item: Message) -> Result<(), Self::Error> {
        Ok(())
    }

    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), Self::Error>> {
        std::task::Poll::Pending
    }

    fn poll_close(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), Self::Error>> {
        std::task::Poll::Ready(Ok(()))
    }
}
