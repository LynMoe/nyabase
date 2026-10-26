//! Code shared by the Nyabase SSH and HTTP proxies: control-token loading,
//! backend TLS/URL validation, control-link liveness, environment parsing,
//! connection limits, task supervision, accept-loop backoff, process instance
//! ids and snapshot clock helpers.

pub mod accept;
pub mod backend_tls;
pub mod clock;
pub mod conn_limit;
pub mod control_link;
pub mod control_token;
pub mod env;
pub mod instance;
pub mod supervise;
