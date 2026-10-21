use crate::snapshot::{DomainPool, Route};
use proxy_common::clock::now_ms;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct ProxySnapshot {
    pub(crate) generation: u64,
    #[serde(rename = "staleAfterMs")]
    pub(crate) stale_after_ms: u64,
    #[serde(rename = "validUntil")]
    pub(crate) valid_until_ms: u64,
    pub(crate) routes: Vec<Route>,
    #[serde(rename = "domainPools")]
    pub(crate) domain_pools: Vec<DomainPool>,
}

#[derive(Deserialize)]
pub(crate) struct Envelope {
    pub(crate) kind: String,
    pub(crate) payload: serde_json::Value,
}

#[derive(Serialize)]
pub(crate) struct StatusReport<'a> {
    pub(crate) ts: u64,
    pub(crate) kind: &'static str,
    pub(crate) payload: StatusPayload<'a>,
}

#[derive(Serialize)]
pub(crate) struct StatusPayload<'a> {
    #[serde(rename = "proxyId")]
    pub(crate) proxy_id: &'a str,
    pub(crate) hostname: Option<&'a str>,
    #[serde(rename = "httpListen")]
    pub(crate) http_listen: &'a str,
    #[serde(rename = "httpsListen")]
    pub(crate) https_listen: Option<&'a str>,
    #[serde(rename = "uptimeMs")]
    pub(crate) uptime_ms: u64,
    #[serde(rename = "connectedAt")]
    pub(crate) connected_at: u64,
    #[serde(rename = "lastSnapshotGeneration")]
    pub(crate) last_snapshot_generation: Option<u64>,
    #[serde(rename = "lastSnapshotAt")]
    pub(crate) last_snapshot_at: Option<u64>,
    #[serde(rename = "activeConnections")]
    pub(crate) active_connections: u64,
    #[serde(rename = "totalRequests")]
    pub(crate) total_requests: u64,
    #[serde(rename = "totalRejectedRequests")]
    pub(crate) total_rejected_requests: u64,
}

pub(crate) fn control_ack_message(generation: u64) -> String {
    serde_json::json!({
        "ts": now_ms(),
        "kind": "ack",
        "payload": { "generation": generation }
    })
    .to_string()
}
