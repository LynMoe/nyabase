//! Code shared by the Nyabase SSH and HTTP proxies: control-token loading,
//! backend TLS/URL validation, environment parsing, task supervision and
//! snapshot clock helpers.

pub mod backend_tls;
pub mod clock;
pub mod control_token;
pub mod env;
pub mod supervise;
