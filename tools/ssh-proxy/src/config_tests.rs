use super::*;
use proxy_common::env::validate_status_interval_ms;
use proxy_common::env::{MAX_STATUS_INTERVAL_MS, MIN_STATUS_INTERVAL_MS};

#[test]
fn connection_cap_and_status_interval_reject_zero_or_excessive_values() {
    assert!(validate_connection_cap(1).is_ok());
    assert!(validate_connection_cap(MAX_PROXY_CONNECTIONS).is_ok());
    assert!(validate_connection_cap(0).is_err());
    assert!(validate_connection_cap(MAX_PROXY_CONNECTIONS + 1).is_err());
    assert!(
        validate_status_interval_ms("NYABASE_SSH_STATUS_INTERVAL_MS", MIN_STATUS_INTERVAL_MS)
            .is_ok()
    );
    assert!(
        validate_status_interval_ms("NYABASE_SSH_STATUS_INTERVAL_MS", MAX_STATUS_INTERVAL_MS)
            .is_ok()
    );
    assert!(validate_status_interval_ms(
        "NYABASE_SSH_STATUS_INTERVAL_MS",
        MIN_STATUS_INTERVAL_MS - 1
    )
    .is_err());
    assert!(validate_status_interval_ms(
        "NYABASE_SSH_STATUS_INTERVAL_MS",
        MAX_STATUS_INTERVAL_MS + 1
    )
    .is_err());
    assert!(validate_auth_timeout(DEFAULT_AUTH_TIMEOUT_MS).is_ok());
    assert!(validate_auth_timeout(MIN_AUTH_TIMEOUT_MS - 1).is_err());
    assert!(validate_auth_timeout(MAX_AUTH_TIMEOUT_MS + 1).is_err());
    const { assert!(DEFAULT_MAX_CONNECTIONS_PER_IP <= MAX_PROXY_CONNECTIONS) };
    assert!(validate_control_hold(SSH_PROXY_CONTROL_HOLD_MIN_MS).is_ok());
    assert!(validate_control_hold(SSH_PROXY_CONTROL_HOLD_MAX_MS).is_ok());
    assert!(validate_control_hold(SSH_PROXY_CONTROL_HOLD_MIN_MS - 1).is_err());
    assert!(validate_control_hold(SSH_PROXY_CONTROL_HOLD_MAX_MS + 1).is_err());
}

#[test]
fn bounds_snapshot_lease_for_fail_closed_control_loss() {
    assert!(!valid_snapshot_stale_after_ms(
        SSH_PROXY_SNAPSHOT_STALE_MIN_MS - 1
    ));
    assert!(valid_snapshot_stale_after_ms(
        SSH_PROXY_SNAPSHOT_STALE_MIN_MS
    ));
    assert!(valid_snapshot_stale_after_ms(
        SSH_PROXY_SNAPSHOT_STALE_MAX_MS
    ));
    assert!(!valid_snapshot_stale_after_ms(
        SSH_PROXY_SNAPSHOT_STALE_MAX_MS + 1
    ));
}
