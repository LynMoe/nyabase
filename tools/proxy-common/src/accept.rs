//! Accept loop helper that survives transient `accept(2)` failures.
//!
//! `EMFILE`/`ENFILE` (descriptor exhaustion), `ENOBUFS`/`ENOMEM` and
//! `ECONNABORTED` are conditions of the moment, not of the listener. Exiting
//! the accept loop on them would take the whole proxy (and every established
//! session) down, so the caller is told about the error and the loop backs
//! off briefly before trying again.

use std::future::Future;
use std::io;
use std::time::Duration;

pub const ACCEPT_BACKOFF_MIN: Duration = Duration::from_millis(5);
pub const ACCEPT_BACKOFF_MAX: Duration = Duration::from_secs(1);

/// Calls `accept` until it succeeds. After each error `on_error` receives the
/// error and the delay that follows it; the delay doubles from
/// [`ACCEPT_BACKOFF_MIN`] up to [`ACCEPT_BACKOFF_MAX`].
pub async fn accept_retrying<T, F, Fut, L>(mut accept: F, mut on_error: L) -> T
where
    F: FnMut() -> Fut,
    Fut: Future<Output = io::Result<T>>,
    L: FnMut(&io::Error, Duration),
{
    let mut delay = ACCEPT_BACKOFF_MIN;
    loop {
        match accept().await {
            Ok(value) => return value,
            Err(error) => {
                on_error(&error, delay);
                tokio::time::sleep(delay).await;
                delay = (delay * 2).min(ACCEPT_BACKOFF_MAX);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[tokio::test]
    async fn transient_errors_are_reported_and_retried_with_growing_backoff() {
        let attempts = Cell::new(0);
        let mut delays = Vec::new();
        let value = accept_retrying(
            || {
                attempts.set(attempts.get() + 1);
                let attempt = attempts.get();
                async move {
                    match attempt {
                        1 => Err(io::Error::from_raw_os_error(libc::EMFILE)),
                        2 => Err(io::Error::from_raw_os_error(libc::ECONNABORTED)),
                        3 => Err(io::Error::from_raw_os_error(libc::ENOBUFS)),
                        _ => Ok(attempt),
                    }
                }
            },
            |_, delay| delays.push(delay),
        )
        .await;
        assert_eq!(value, 4);
        assert_eq!(
            delays,
            vec![
                ACCEPT_BACKOFF_MIN,
                ACCEPT_BACKOFF_MIN * 2,
                ACCEPT_BACKOFF_MIN * 4
            ]
        );
    }
}
