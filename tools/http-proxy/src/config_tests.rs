use super::*;
use proxy_common::env::validate_status_interval_ms;
use proxy_common::env::{MAX_STATUS_INTERVAL_MS, MIN_STATUS_INTERVAL_MS};

#[test]
fn http_connection_cap_and_status_interval_are_hard_bounded() {
    assert_eq!(validate_connection_cap(1).unwrap(), 1);
    assert_eq!(
        validate_connection_cap(MAX_ACTIVE_CONNECTIONS).unwrap(),
        MAX_ACTIVE_CONNECTIONS
    );
    assert!(validate_connection_cap(0).is_err());
    assert!(validate_connection_cap(MAX_ACTIVE_CONNECTIONS + 1).is_err());
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
