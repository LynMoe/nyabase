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
        assert!(DEFAULT_BODY_DEADLINE_MS < REQUEST_LIFETIME_DEADLINE.as_millis() as u64);
        assert!(DEFAULT_CONTROL_HOLD_MS <= MAX_CONTROL_HOLD_MS);
    }
    assert!(validate_ms("NYABASE_HTTP_CONTROL_HOLD_MS", 0, 0, MAX_CONTROL_HOLD_MS).is_ok());
    let error = validate_ms(
        "NYABASE_HTTP_BODY_DEADLINE_MS",
        REQUEST_LIFETIME_DEADLINE.as_millis() as u64 + 1,
        MIN_BODY_DEADLINE_MS,
        REQUEST_LIFETIME_DEADLINE.as_millis() as u64,
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
