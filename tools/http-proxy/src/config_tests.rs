use super::*;
use proxy_common::env::validate_status_interval_ms;
use proxy_common::env::{MAX_STATUS_INTERVAL_MS, MIN_STATUS_INTERVAL_MS};

#[test]
fn http_limits_and_status_interval_are_hard_bounded() {
    assert_eq!(MAX_CONNECTIONS_LIMIT, 65_536);
    const {
        assert!(DEFAULT_MAX_CONNECTIONS == 4_096);
        assert!(DEFAULT_MAX_CONNECTIONS_PER_IP == 64);
        assert!(DEFAULT_MAX_CONNECTIONS <= MAX_CONNECTIONS_LIMIT);
        assert!(DEFAULT_BODY_DEADLINE_MS <= MAX_BODY_DEADLINE_MS);
        assert!(DEFAULT_IDLE_TIMEOUT_MS >= MIN_IDLE_TIMEOUT_MS);
        assert!(DEFAULT_IDLE_TIMEOUT_MS <= MAX_IDLE_TIMEOUT_MS);
        // The pending pool must leave room for established connections.
        assert!(DEFAULT_MAX_PENDING_CONNECTIONS < DEFAULT_MAX_CONNECTIONS);
        // A few sources must not be able to hold the whole pending pool.
        assert!(DEFAULT_MAX_PENDING_CONNECTIONS_PER_IP <= DEFAULT_MAX_CONNECTIONS_PER_IP / 4);
        assert!(DEFAULT_MAX_PENDING_CONNECTIONS_PER_IP * 64 <= DEFAULT_MAX_PENDING_CONNECTIONS);
        assert!(DEFAULT_MAX_PENDING_CONNECTIONS_PER_IPV6_48 <= DEFAULT_MAX_CONNECTIONS_PER_IPV6_48);
        assert!(
            DEFAULT_MAX_PENDING_CONNECTIONS_PER_IPV6_48 * 16 <= DEFAULT_MAX_PENDING_CONNECTIONS
        );
        assert!(DEFAULT_MAX_CONNECTIONS_PER_IPV6_48 <= MAX_CONNECTIONS_LIMIT);
        assert!(DEFAULT_CONTROL_HOLD_MS <= MAX_CONTROL_HOLD_MS);
        // One container must not be able to take the whole pool.
        assert!(DEFAULT_MAX_CONNECTIONS_PER_CONTAINER < DEFAULT_MAX_CONNECTIONS);
        // Nor a few clients one container, nor one owner the pool.
        assert!(
            DEFAULT_MAX_CONNECTIONS_PER_IP_PER_CONTAINER * 16
                <= DEFAULT_MAX_CONNECTIONS_PER_CONTAINER
        );
        assert!(DEFAULT_MAX_CONNECTIONS_PER_IP_PER_CONTAINER <= DEFAULT_MAX_CONNECTIONS_PER_IP);
        assert!(DEFAULT_MAX_CONNECTIONS_PER_OWNER >= DEFAULT_MAX_CONNECTIONS_PER_CONTAINER);
        assert!(DEFAULT_MAX_CONNECTIONS_PER_OWNER * 4 <= DEFAULT_MAX_CONNECTIONS);
        assert!(DEFAULT_RESPONSE_LIFETIME_MS >= MIN_RESPONSE_LIFETIME_MS);
        assert!(DEFAULT_RESPONSE_LIFETIME_MS <= MAX_RESPONSE_LIFETIME_MS);
        // Long downloads and SSE outlive many idle periods.
        assert!(DEFAULT_RESPONSE_LIFETIME_MS >= 10 * DEFAULT_IDLE_TIMEOUT_MS);
    }
    assert!(validate_ms("NYABASE_HTTP_CONTROL_HOLD_MS", 0, 0, MAX_CONTROL_HOLD_MS).is_ok());
    let error = validate_ms(
        "NYABASE_HTTP_BODY_DEADLINE_MS",
        MAX_BODY_DEADLINE_MS + 1,
        MIN_BODY_DEADLINE_MS,
        MAX_BODY_DEADLINE_MS,
    )
    .unwrap_err();
    assert!(error.to_string().contains("NYABASE_HTTP_BODY_DEADLINE_MS"));
    assert!(validate_ms(
        "NYABASE_HTTP_UPGRADED_IDLE_MS",
        MIN_UPGRADED_IDLE_MS - 1,
        MIN_UPGRADED_IDLE_MS,
        MAX_UPGRADED_IDLE_MS
    )
    .is_err());
    assert_eq!(
        validate_status_interval_ms("NYABASE_HTTP_STATUS_INTERVAL_MS", MIN_STATUS_INTERVAL_MS)
            .unwrap(),
        MIN_STATUS_INTERVAL_MS
    );
    assert!(validate_status_interval_ms(
        "NYABASE_HTTP_STATUS_INTERVAL_MS",
        MIN_STATUS_INTERVAL_MS - 1
    )
    .is_err());
    assert!(validate_status_interval_ms(
        "NYABASE_HTTP_STATUS_INTERVAL_MS",
        MAX_STATUS_INTERVAL_MS + 1
    )
    .is_err());
}
