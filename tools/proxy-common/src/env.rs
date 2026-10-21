//! Environment variable parsing helpers.

use anyhow::{Context, Result};

pub fn env_u64(name: &str, fallback: u64) -> Result<u64> {
    match std::env::var(name) {
        Ok(value) => value
            .parse()
            .with_context(|| format!("{name} must be an unsigned integer")),
        Err(std::env::VarError::NotPresent) => Ok(fallback),
        Err(error) => Err(error).with_context(|| format!("failed to read {name}")),
    }
}

pub fn env_usize(name: &str, fallback: usize) -> Result<usize> {
    match std::env::var(name) {
        Ok(value) => value
            .parse()
            .with_context(|| format!("{name} must be an unsigned integer")),
        Err(std::env::VarError::NotPresent) => Ok(fallback),
        Err(error) => Err(error).with_context(|| format!("failed to read {name}")),
    }
}

pub const MIN_STATUS_INTERVAL_MS: u64 = 250;
pub const MAX_STATUS_INTERVAL_MS: u64 = 60_000;

/// Validates a status-report interval read from `name` (the env var).
pub fn validate_status_interval_ms(name: &str, value: u64) -> Result<u64> {
    if !(MIN_STATUS_INTERVAL_MS..=MAX_STATUS_INTERVAL_MS).contains(&value) {
        anyhow::bail!("{name} must be in {MIN_STATUS_INTERVAL_MS}..={MAX_STATUS_INTERVAL_MS}");
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_variables_fall_back_and_present_ones_must_parse() {
        let unset = "NYABASE_PROXY_COMMON_TEST_UNSET";
        assert_eq!(env_u64(unset, 7).unwrap(), 7);
        assert_eq!(env_usize(unset, 9).unwrap(), 9);

        let set = "NYABASE_PROXY_COMMON_TEST_SET";
        std::env::set_var(set, "42");
        assert_eq!(env_u64(set, 7).unwrap(), 42);
        assert_eq!(env_usize(set, 9).unwrap(), 42);
        std::env::set_var(set, "forty-two");
        let error = env_u64(set, 7).unwrap_err();
        assert!(error.to_string().contains("must be an unsigned integer"));
        assert!(env_usize(set, 9).is_err());
        std::env::remove_var(set);
    }

    #[test]
    fn status_interval_is_bounded_and_names_the_variable() {
        assert!(validate_status_interval_ms("X", MIN_STATUS_INTERVAL_MS).is_ok());
        assert!(validate_status_interval_ms("X", MAX_STATUS_INTERVAL_MS).is_ok());
        assert!(validate_status_interval_ms("X", MIN_STATUS_INTERVAL_MS - 1).is_err());
        let error = validate_status_interval_ms("NYABASE_X_STATUS_INTERVAL_MS", 0).unwrap_err();
        assert!(error.to_string().contains("NYABASE_X_STATUS_INTERVAL_MS"));
    }
}
