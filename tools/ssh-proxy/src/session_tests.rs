use crate::test_support::*;
use pretty_assertions::assert_eq;

#[test]
fn resolves_owned_route_by_user_and_target_ip() {
    let snapshot = fixture_snapshot();
    let route = snapshot
        .resolve_owned_route_for_user_ip("user-a", "10.0.0.4")
        .expect("expected solo route");
    assert_eq!(route.container_name, "solo");
    assert_eq!(route.routed_ip, "10.0.0.4");
    assert!(snapshot
        .resolve_owned_route_for_user_ip("user-a", "10.0.0.99")
        .is_err());
}
