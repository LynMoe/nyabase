//! Wall-clock helpers and snapshot lease bounds.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};

pub const MAX_SNAPSHOT_CLOCK_SKEW_MS: u64 = 30_000;

/// Remaining lifetime of an absolute `validUntil` lease. `label` names the
/// proxy in error messages (e.g. "SSH proxy").
pub fn absolute_snapshot_remaining(
    label: &str,
    valid_until_ms: u64,
    stale_after_ms: u64,
    wall_now_ms: u64,
) -> Result<Duration> {
    let latest_allowed = wall_now_ms
        .checked_add(stale_after_ms)
        .and_then(|value| value.checked_add(MAX_SNAPSHOT_CLOCK_SKEW_MS))
        .with_context(|| format!("{label} snapshot absolute lease overflow"))?;
    if valid_until_ms > latest_allowed {
        anyhow::bail!("{label} snapshot validUntil is too far in the future");
    }
    let remaining_ms = valid_until_ms
        .checked_sub(wall_now_ms)
        .filter(|remaining| *remaining > 0)
        .with_context(|| format!("{label} snapshot absolute lease already expired"))?;
    Ok(Duration::from_millis(remaining_ms))
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lease_remaining_is_bounded_by_stale_window_and_clock_skew() {
        let now = 1_000_000;
        let stale = 120_000;
        assert_eq!(
            absolute_snapshot_remaining("test", now + 5_000, stale, now).unwrap(),
            Duration::from_millis(5_000)
        );
        let latest = now + stale + MAX_SNAPSHOT_CLOCK_SKEW_MS;
        assert!(absolute_snapshot_remaining("test", latest, stale, now).is_ok());
        let error = absolute_snapshot_remaining("test", latest + 1, stale, now).unwrap_err();
        assert!(error.to_string().contains("test snapshot validUntil"));
    }

    #[test]
    fn expired_or_overflowing_leases_are_rejected() {
        let now = 1_000_000;
        assert!(absolute_snapshot_remaining("test", now, 1, now).is_err());
        assert!(absolute_snapshot_remaining("test", now - 1, 1, now).is_err());
        assert!(absolute_snapshot_remaining("test", 1, u64::MAX, now).is_err());
    }

    #[test]
    fn now_ms_is_after_2020() {
        assert!(now_ms() > 1_577_836_800_000);
    }
}
