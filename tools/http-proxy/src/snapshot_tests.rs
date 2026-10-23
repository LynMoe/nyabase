use super::*;
use crate::config::MAX_SNAPSHOT_STALE_AFTER_MS;
use crate::control::install_snapshot;
use crate::listener::wait_until_route_revoked;
use crate::protocol::ProxySnapshot;
use crate::test_support::*;
use proxy_common::clock::now_ms;
use std::sync::Arc;
use std::time::Duration;
use tokio::time;

#[test]
fn matches_single_label_wildcard() {
    assert!(hostname_matches_wildcard(
        "app.example.test",
        "*.example.test"
    ));
    assert!(!hostname_matches_wildcard(
        "deep.app.example.test",
        "*.example.test"
    ));
}

#[test]
fn rejects_snapshot_rollback_within_one_connection_epoch() {
    let store = SnapshotStore::default();
    let snapshot = |generation| ProxySnapshot {
        generation,
        stale_after_ms: 30_000,
        valid_until_ms: now_ms() + 30_000,
        routes: Vec::new(),
        domain_pools: Vec::new(),
    };

    assert!(store.store(snapshot(2)).unwrap().is_some());
    assert!(store.store(snapshot(1)).unwrap().is_none());
    assert!(store.store(snapshot(2)).unwrap().is_none());
    assert_eq!(store.load().unwrap().generation, 2);

    store.clear_epoch();
    assert!(store.store(snapshot(1)).unwrap().is_some());
    assert_eq!(store.load().unwrap().generation, 1);
}

#[test]
fn snapshot_lease_is_required_and_bounded() {
    assert!(serde_json::from_value::<ProxySnapshot>(serde_json::json!({
        "generation": 1,
        "routes": [],
        "domainPools": []
    }))
    .is_err());

    let store = SnapshotStore::default();
    assert!(store
        .store(ProxySnapshot {
            generation: 1,
            stale_after_ms: MAX_SNAPSHOT_STALE_AFTER_MS + 1,
            valid_until_ms: now_ms() + MAX_SNAPSHOT_STALE_AFTER_MS + 1,
            routes: Vec::new(),
            domain_pools: Vec::new(),
        })
        .is_err());
}

#[test]
fn one_invalid_tls_pool_rejects_the_whole_snapshot_without_partial_install() {
    let store = SnapshotStore::default();
    store
        .store(test_snapshot(1, 30_000, vec![test_route(8080)]))
        .unwrap();
    let mut invalid = test_snapshot(2, 30_000, vec![test_route(8081)]);
    invalid.domain_pools = vec![DomainPool {
        wildcard_domain: "*.example.test".to_string(),
        certificate_pem: None,
        private_key_pem: Some("not-a-key".to_string()),
    }];

    assert!(store.store(invalid).is_err());
    assert_eq!(store.load().map(|snapshot| snapshot.generation), Some(1));
}

#[tokio::test]
async fn expires_without_an_update_and_keeps_the_generation_fence() {
    let route = test_route(9);
    let store = Arc::new(SnapshotStore::default());
    assert_eq!(
        install_snapshot(&store, test_snapshot(1, 20, vec![route.clone()])).unwrap(),
        Some(1)
    );

    time::sleep(Duration::from_millis(50)).await;

    assert!(store.load().is_none());
    assert!(!store.route_is_current(&route));
    assert!(store
        .store(test_snapshot(1, 20, vec![route]))
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn request_side_deadline_revokes_even_without_the_global_expiry_task() {
    let route = test_route(9);
    let store = SnapshotStore::default();
    store
        .store(test_snapshot(1, 20, vec![route.clone()]))
        .unwrap();
    let authorization = store.authorize_route(&route.hostname).unwrap();
    let mut changes = store.subscribe();

    time::timeout(
        Duration::from_millis(200),
        wait_until_route_revoked(&store, &authorization, &mut changes),
    )
    .await
    .expect("request-side lease deadline did not revoke authorization");

    assert!(!store.authorization_is_current(&authorization));
}

#[tokio::test]
async fn a_periodic_renewal_extends_service_past_the_previous_deadline() {
    let route = test_route(9);
    let store = Arc::new(SnapshotStore::default());
    assert_eq!(
        install_snapshot(&store, test_snapshot(1, 120, vec![route.clone()])).unwrap(),
        Some(1)
    );
    let authorization = store.authorize_route(&route.hostname).unwrap();
    let mut changes = store.subscribe();
    let request_store = store.clone();
    let request_lease = tokio::spawn(async move {
        wait_until_route_revoked(&request_store, &authorization, &mut changes).await;
    });
    time::sleep(Duration::from_millis(40)).await;
    assert_eq!(
        install_snapshot(&store, test_snapshot(2, 120, vec![route.clone()])).unwrap(),
        Some(2)
    );

    time::sleep(Duration::from_millis(90)).await;
    assert_eq!(store.load().map(|snapshot| snapshot.generation), Some(2));
    assert!(store.route_is_current(&route));
    assert!(!request_lease.is_finished());

    time::sleep(Duration::from_millis(50)).await;
    assert!(store.load().is_none());
    time::timeout(Duration::from_millis(200), request_lease)
        .await
        .expect("renewed request did not stop at the new deadline")
        .unwrap();
}

#[test]
fn route_removal_invalidates_an_existing_authority_tuple() {
    let store = SnapshotStore::default();
    let route = Route {
        binding_id: "binding-a".into(),
        hostname: "app.example.test".into(),
        domain_pool_id: "pool-a".into(),
        routed_ip: "10.0.0.2".into(),
        target_port: 8080,
        owner_id: "user-a".into(),
        container_id: "container-a".into(),
        container_name: "app".into(),
        instance_name: "instance-a".into(),
        status: "running".into(),
    };
    assert!(store
        .store(ProxySnapshot {
            generation: 1,
            stale_after_ms: 30_000,
            valid_until_ms: now_ms() + 30_000,
            routes: vec![route.clone()],
            domain_pools: Vec::new(),
        })
        .unwrap()
        .is_some());
    assert!(store.route_is_current(&route));
    assert!(store
        .store(ProxySnapshot {
            generation: 2,
            stale_after_ms: 30_000,
            valid_until_ms: now_ms() + 30_000,
            routes: Vec::new(),
            domain_pools: Vec::new(),
        })
        .unwrap()
        .is_some());
    assert!(!store.route_is_current(&route));
}

#[test]
fn a_removed_then_readded_route_cannot_revive_an_existing_request() {
    let store = SnapshotStore::default();
    let route = test_route(8080);
    store
        .store(test_snapshot(1, 30_000, vec![route.clone()]))
        .unwrap();
    let authorization = store.authorize_route(&route.hostname).unwrap();

    store.store(test_snapshot(2, 30_000, Vec::new())).unwrap();
    store.store(test_snapshot(3, 30_000, vec![route])).unwrap();

    assert!(!store.authorization_is_current(&authorization));
}

#[test]
fn runtime_identity_change_revokes_even_when_the_network_target_is_reused() {
    let store = SnapshotStore::default();
    let route = test_route(8080);
    store
        .store(test_snapshot(1, 30_000, vec![route.clone()]))
        .unwrap();
    let authorization = store.authorize_route(&route.hostname).unwrap();
    let mut replacement = route;
    replacement.instance_name = "instance-b".into();

    store
        .store(test_snapshot(2, 30_000, vec![replacement]))
        .unwrap();

    assert!(!store.authorization_is_current(&authorization));
}

fn other_route() -> Route {
    Route {
        binding_id: "binding-b".into(),
        hostname: "other.example.test".into(),
        owner_id: "user-b".into(),
        container_id: "container-b".into(),
        instance_name: "instance-b".into(),
        ..test_route(9090)
    }
}

#[test]
fn removing_or_changing_another_route_leaves_an_existing_authorization_current() {
    let store = SnapshotStore::default();
    let route = test_route(8080);
    store
        .store(test_snapshot(1, 30_000, vec![route.clone(), other_route()]))
        .unwrap();
    let authorization = store.authorize_route(&route.hostname).unwrap();
    let other_authorization = store.authorize_route("other.example.test").unwrap();

    // The other tenant flips its target port: only its own exchanges end.
    let mut changed = other_route();
    changed.target_port = 9091;
    store
        .store(test_snapshot(2, 30_000, vec![route.clone(), changed]))
        .unwrap();
    assert!(store.authorization_is_current(&authorization));
    assert!(!store.authorization_is_current(&other_authorization));

    // The other route disappears altogether (container stopped, binding
    // deleted, owner disabled).
    store
        .store(test_snapshot(3, 30_000, vec![route.clone()]))
        .unwrap();
    assert!(store.authorization_is_current(&authorization));

    // A new unrelated route appears.
    store
        .store(test_snapshot(4, 30_000, vec![route, other_route()]))
        .unwrap();
    assert!(store.authorization_is_current(&authorization));
}

#[test]
fn a_new_control_epoch_keeps_unchanged_routes_and_revokes_changed_ones() {
    let store = SnapshotStore::default();
    let route = test_route(8080);
    store
        .store(test_snapshot(7, 30_000, vec![route.clone(), other_route()]))
        .unwrap();
    let authorization = store.authorize_route(&route.hostname).unwrap();
    let other_authorization = store.authorize_route("other.example.test").unwrap();

    // A restarted Backend starts again from generation 1.
    store.begin_control_epoch();
    let mut moved = other_route();
    moved.routed_ip = "10.0.0.9".into();
    store
        .store(test_snapshot(1, 30_000, vec![route, moved]))
        .unwrap();

    assert!(store.authorization_is_current(&authorization));
    assert!(!store.authorization_is_current(&other_authorization));
}

#[test]
fn a_target_port_change_revokes_the_route_itself() {
    let store = SnapshotStore::default();
    let route = test_route(8080);
    store
        .store(test_snapshot(1, 30_000, vec![route.clone()]))
        .unwrap();
    let authorization = store.authorize_route(&route.hostname).unwrap();

    store
        .store(test_snapshot(2, 30_000, vec![test_route(8081)]))
        .unwrap();
    assert!(!store.authorization_is_current(&authorization));

    // Going back to the old port is a new incarnation, not the old one.
    store.store(test_snapshot(3, 30_000, vec![route])).unwrap();
    assert!(!store.authorization_is_current(&authorization));
}

#[tokio::test]
async fn an_expired_lease_ends_every_route_and_a_reinstalled_route_is_new() {
    let store = SnapshotStore::default();
    let route = test_route(8080);
    store
        .store(test_snapshot(1, 20, vec![route.clone(), other_route()]))
        .unwrap();
    let authorization = store.authorize_route(&route.hostname).unwrap();
    let other_authorization = store.authorize_route("other.example.test").unwrap();

    time::sleep(Duration::from_millis(50)).await;
    store
        .store(test_snapshot(2, 30_000, vec![route, other_route()]))
        .unwrap();

    assert!(!store.authorization_is_current(&authorization));
    assert!(!store.authorization_is_current(&other_authorization));
}
