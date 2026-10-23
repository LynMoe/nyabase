//! Code shared by the Nyabase SSH and HTTP proxies: control-token loading,
//! backend TLS/URL validation, environment parsing, connection limits, task
//! supervision, accept-loop backoff and snapshot clock helpers.

pub mod accept;
pub mod backend_tls;
pub mod clock;
pub mod conn_limit;
pub mod control_token;
pub mod env;
pub mod supervise;
