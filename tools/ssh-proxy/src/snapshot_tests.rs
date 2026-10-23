use super::*;
use crate::control::ControlPlane;
use crate::test_support::*;
use pretty_assertions::assert_eq;

#[test]
fn parses_two_and_three_part_logins_case_insensitively() {
    assert_eq!(
        ParsedLogin::parse("Alice.Work"),
        Some(ParsedLogin {
            username: "alice".to_string(),
            server_slug: None,
            container_name: "work".to_string(),
        }),
    );
    assert_eq!(
        ParsedLogin::parse("Alice.CPU-A.Work"),
        Some(ParsedLogin {
            username: "alice".to_string(),
            server_slug: Some("cpu-a".to_string()),
            container_name: "work".to_string(),
        }),
    );
    assert_eq!(ParsedLogin::parse("alice.cpu-a.work.extra"), None);
}

#[test]
fn rejects_ambiguous_omitted_server_login() {
    let snapshot = fixture_snapshot();
    assert_rejects(
        snapshot.resolve_login("alice.work"),
        RejectReason::AmbiguousContainer,
    );
}

#[test]
fn accepts_unique_omitted_server_and_explicit_duplicate() {
    let snapshot = fixture_snapshot();
    let RouteResolution::Accepted(unique) = snapshot.resolve_login("alice.solo") else {
        panic!("expected accepted route");
    };
    assert_eq!(unique.container.id, "container-c");
    assert_eq!(unique.server.slug, "cpu-a");

    let RouteResolution::Accepted(explicit) = snapshot.resolve_login("ALICE.CPU-B.WORK") else {
        panic!("expected accepted route");
    };
    assert_eq!(explicit.container.id, "container-b");
    assert_eq!(explicit.server.slug, "cpu-b");
}

#[test]
fn rejects_disabled_user_disabled_image_and_inactive_routes() {
    let snapshot = fixture_snapshot();
    assert_rejects(
        snapshot.resolve_login("disabled.solo"),
        RejectReason::UserDisabled,
    );
    assert_rejects(
        snapshot.resolve_login("alice.gpu"),
        RejectReason::RouteNotFound,
    );
    assert_rejects(
        snapshot.resolve_login("alice.sleeping"),
        RejectReason::RouteNotFound,
    );
}

#[test]
fn parses_authorized_key_lines_with_comments() {
    let parsed = parse_authorized_key(ALICE_KEY).expect("expected public key");
    let without_comment = parse_authorized_key(
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILM+rvN+ot98qgEN796jTiQfZfG1KaT0PtFDJ/XFSqti",
    )
    .expect("expected public key without comment");
    let with_option = parse_authorized_key(
        "restrict ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILM+rvN+ot98qgEN796jTiQfZfG1KaT0PtFDJ/XFSqti",
    )
    .expect("expected public key with option prefix");
    assert_eq!(parsed, without_comment);
    assert_eq!(parsed, with_option);
    assert_eq!(parse_authorized_key("not-a-key"), None);
}

#[test]
fn public_key_auth_matches_snapshot_user_keys_for_any_login() {
    let snapshot = fixture_snapshot();
    let allowed = parse_authorized_key(ALICE_KEY).expect("expected allowed key");
    let other = parse_authorized_key(OTHER_KEY).expect("expected other key");

    assert!(snapshot.public_key_allowed("alice.cpu-a.solo", &allowed));
    assert!(snapshot.public_key_allowed("literally-any-username", &allowed));
    assert!(snapshot.public_key_allowed("root", &allowed));
    assert!(!snapshot.public_key_allowed("alice.cpu-a.solo", &other));
    assert_eq!(
        snapshot
            .find_active_user_by_public_key(&allowed)
            .unwrap()
            .username,
        "alice"
    );
    assert!(snapshot.find_active_user_by_public_key(&other).is_err());
}

#[test]
fn resolves_direct_tcpip_targets_by_container_name_within_the_owner() {
    let snapshot = fixture_snapshot();
    for target in ["solo", "SOLO", "solo.nya", "Solo.NYA.", "10.0.0.4"] {
        let route = snapshot
            .resolve_owned_route_for_user_target("user-a", target)
            .unwrap_or_else(|reason| panic!("{target}: {reason}"));
        assert_eq!(route.container_id, "container-c", "{target}");
        assert_eq!(route.routed_ip, "10.0.0.4", "{target}");
    }
    // user-b owns another `solo`, never alice's.
    let foreign = snapshot
        .resolve_owned_route_for_user_target("user-b", "solo.nya")
        .unwrap();
    assert_eq!(foreign.container_id, "container-f");
    assert_eq!(
        snapshot
            .resolve_owned_route_for_user_target("user-b", "10.0.0.4")
            .unwrap_err(),
        RejectReason::RouteNotFound,
    );
}

#[test]
fn rejects_ambiguous_inactive_and_malformed_name_targets() {
    let snapshot = fixture_snapshot();
    let resolve = |target: &str| {
        snapshot
            .resolve_owned_route_for_user_target("user-a", target)
            .unwrap_err()
    };
    assert_eq!(resolve("work.nya"), RejectReason::AmbiguousContainer);
    assert_eq!(resolve("sleeping.nya"), RejectReason::RouteNotFound);
    assert_eq!(resolve("gpu"), RejectReason::RouteNotFound);
    assert_eq!(resolve("missing.nya"), RejectReason::RouteNotFound);
    for target in ["solo.other", "a.solo.nya", "-solo", "", ".nya", "so_lo"] {
        assert_eq!(resolve(target), RejectReason::InvalidTarget, "{target:?}");
    }
}

#[test]
fn indexes_only_active_users_and_refuses_a_shared_key() {
    let mut proxy = fixture_proxy_snapshot(7);
    proxy.users[1].public_keys = vec![ALICE_KEY.to_string()];
    let disabled_holder = RoutingSnapshot::from_snapshot(proxy.clone()).unwrap();
    let alice = parse_authorized_key(ALICE_KEY).unwrap();
    assert_eq!(
        disabled_holder
            .find_active_user_by_public_key(&alice)
            .unwrap()
            .id,
        "user-a"
    );
    proxy.users[1].status = "active".to_string();
    let shared = RoutingSnapshot::from_snapshot(proxy).unwrap();
    assert_eq!(
        shared.find_active_user_by_public_key(&alice).unwrap_err(),
        RejectReason::AmbiguousUser,
    );
}

#[test]
fn rejects_inactive_routes_with_stopped_ssh_or_missing_instance() {
    let mut snapshot = fixture_snapshot();
    let route = snapshot
        .routes_by_container_id
        .get_mut("container-c")
        .expect("fixture route");
    route.ssh_status = "stopped".to_string();
    assert_rejects(
        snapshot.resolve_login("alice.solo"),
        RejectReason::RouteNotFound,
    );

    let route = snapshot
        .routes_by_container_id
        .get_mut("container-c")
        .expect("fixture route");
    route.ssh_status = "running".to_string();
    route.instance_name.clear();
    assert_rejects(
        snapshot.resolve_login("alice.solo"),
        RejectReason::RouteNotFound,
    );
}

#[test]
fn rejects_offline_wrong_server_and_non_routable_route_addresses() {
    let mut offline = fixture_proxy_snapshot(8);
    offline
        .servers
        .iter_mut()
        .find(|server| server.id == "server-a")
        .unwrap()
        .status = "unreachable".to_string();
    assert_rejects(
        RoutingSnapshot::from_snapshot(offline)
            .unwrap()
            .resolve_login("alice.solo"),
        RejectReason::RouteNotFound,
    );

    let mut wrong_server = fixture_proxy_snapshot(9);
    wrong_server
        .routes
        .iter_mut()
        .find(|route| route.container_id == "container-c")
        .unwrap()
        .server_id = "server-b".to_string();
    assert_rejects(
        RoutingSnapshot::from_snapshot(wrong_server)
            .unwrap()
            .resolve_login("alice.solo"),
        RejectReason::RouteNotFound,
    );

    for address in ["127.0.0.1", "0.0.0.0", "not-an-ip"] {
        let mut invalid_ip = fixture_proxy_snapshot(10);
        invalid_ip
            .routes
            .iter_mut()
            .find(|route| route.container_id == "container-c")
            .unwrap()
            .routed_ip = Some(address.to_string());
        assert_rejects(
            RoutingSnapshot::from_snapshot(invalid_ip)
                .unwrap()
                .resolve_login("alice.solo"),
            RejectReason::RouteNotFound,
        );
    }
}

#[test]
fn snapshot_store_rejects_non_increasing_generation_within_an_epoch() {
    let store = SnapshotStore::default();
    assert!(store.store(fixture_proxy_snapshot(7), 0).unwrap());
    assert!(!store.store(fixture_proxy_snapshot(6), 0).unwrap());
    assert!(!store.store(fixture_proxy_snapshot(7), 0).unwrap());
    assert_eq!(store.load().map(|snapshot| snapshot.generation), Some(7));

    let control = ControlPlane::new();
    control.begin_epoch();
    assert!(store.load().is_some());
    assert!(store
        .store(fixture_proxy_snapshot(1), control.epoch())
        .unwrap());
    assert_eq!(store.load().map(|snapshot| snapshot.generation), Some(1));
    assert_eq!(
        store.load().map(|snapshot| snapshot.epoch),
        Some(control.epoch())
    );
}

fn assert_rejects(actual: RouteResolution<'_>, expected: RejectReason) {
    match actual {
        RouteResolution::Rejected(reason) => assert_eq!(reason, expected),
        RouteResolution::Accepted(route) => panic!("expected rejection, got {route:?}"),
    }
}
