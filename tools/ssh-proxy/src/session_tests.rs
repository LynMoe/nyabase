use super::*;
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

#[test]
fn only_short_printable_ascii_logins_are_acceptable() {
    assert!(acceptable_login("alice.cpu-a.solo"));
    assert!(acceptable_login(&"a".repeat(MAX_SSH_LOGIN_BYTES)));
    assert!(!acceptable_login(""));
    assert!(!acceptable_login(&"a".repeat(MAX_SSH_LOGIN_BYTES + 1)));
    assert!(!acceptable_login("alicé"));
    assert!(!acceptable_login("alice\u{0}"));
    assert!(!acceptable_login("alice\n"));
}

mod login_bounds {
    use super::super::*;
    use crate::control::ControlPlane;
    use crate::protocol::ProxyEvent;
    use crate::runtime::ConnectionState;
    use crate::snapshot::{parse_authorized_key, SnapshotStore};
    use crate::test_support::*;
    use std::sync::Arc;
    use tokio::sync::mpsc;

    fn authoritative_session() -> (ProxySshSession, mpsc::Receiver<ProxyEvent>) {
        let store = Arc::new(SnapshotStore::default());
        let control = Arc::new(ControlPlane::new());
        control.begin_epoch();
        assert!(store
            .store(fixture_proxy_snapshot(7), control.epoch())
            .unwrap());
        control.resume_authoritative();
        let peer = "127.0.0.1:2600".parse().unwrap();
        let (connection, _) = ConnectionState::new(1, peer);
        let (tx, rx) = mpsc::channel(16);
        let session = ProxySshSession::new(
            store,
            control,
            test_config(),
            peer,
            tx,
            Arc::new(connection),
            false,
        );
        (session, rx)
    }

    #[tokio::test]
    async fn oversized_or_non_ascii_logins_are_rejected_before_key_lookup() {
        let key = parse_authorized_key(ALICE_KEY).unwrap();
        for login in ["a".repeat(250 * 1024), "alicé.solo".to_string()] {
            let (mut session, mut telemetry) = authoritative_session();
            let offered = session.auth_offered_key(&login, &key).await.unwrap();
            assert!(matches!(offered, Auth::Reject { .. }));
            let accepted = session.auth_verified_key(&login, &key).await.unwrap();
            assert!(matches!(accepted, Auth::Reject { .. }));
            assert!(lock(&session.connection.login).is_none());
            assert!(lock(&session.connection.authenticated_user_id).is_none());
            let Ok(ProxyEvent::Audit(audit)) = telemetry.try_recv() else {
                panic!("expected a login audit event");
            };
            assert_eq!(audit.reason.as_deref(), Some("invalid_login"));
            assert!(!audit.ok);
            assert_eq!(audit.username, None, "the raw login must not be echoed");
        }

        let (mut session, _telemetry) = authoritative_session();
        let accepted = session.auth_verified_key("alice.solo", &key).await.unwrap();
        assert!(matches!(accepted, Auth::Accept));
        assert_eq!(
            lock(&session.connection.login).as_deref(),
            Some("alice.solo")
        );
    }
}
