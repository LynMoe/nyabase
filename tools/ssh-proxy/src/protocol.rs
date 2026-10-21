use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio::sync::mpsc;

pub(crate) type TelemetrySender = mpsc::Sender<ProxyEvent>;

#[derive(Debug, Deserialize)]
pub(crate) struct BackendEnvelope {
    pub(crate) kind: String,
    pub(crate) payload: serde_json::Value,
}

#[derive(Debug, Serialize)]
pub(crate) struct ClientEnvelope<T> {
    pub(crate) ts: u64,
    pub(crate) kind: &'static str,
    pub(crate) payload: T,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SshProxyAck {
    pub(crate) generation: u64,
}

#[derive(Debug, Serialize)]
pub(crate) struct SshProxyMetrics {
    pub(crate) metrics: Vec<SshProxyMetric>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct SshProxyMetric {
    pub(crate) name: String,
    pub(crate) labels: HashMap<String, String>,
    pub(crate) value: f64,
    pub(crate) ts: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SshProxyAuditEvent {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) container_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) server_id: Option<String>,
    pub(crate) action: String,
    pub(crate) ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) reason: Option<String>,
    pub(crate) ts: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SshProxyPauseAdmitCommand {
    pub(crate) reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SshProxyDisconnectAllCommand {
    pub(crate) request_id: String,
    pub(crate) reason: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SshProxyDisconnectAllResult {
    pub(crate) request_id: String,
    pub(crate) disconnected: usize,
}

#[derive(Debug)]
pub(crate) enum ProxyEvent {
    Metric(SshProxyMetric),
    Audit(SshProxyAuditEvent),
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProxySnapshot {
    pub(crate) generation: u64,
    pub(crate) stale_after_ms: u64,
    pub(crate) valid_until: u64,
    pub(crate) host_key: ProxyHostKey,
    pub(crate) users: Vec<ProxyUser>,
    pub(crate) servers: Vec<ProxyServer>,
    pub(crate) images: Vec<ProxyImage>,
    pub(crate) containers: Vec<ProxyContainer>,
    pub(crate) routes: Vec<ProxyRoute>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub(crate) struct ProxyHostKey {
    pub(crate) private_key: String,
    pub(crate) public_key: String,
    pub(crate) fingerprint: String,
    pub(crate) generation: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub(crate) struct ProxyUser {
    pub(crate) id: String,
    pub(crate) username: String,
    pub(crate) status: String,
    pub(crate) public_keys: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub(crate) struct ProxyServer {
    pub(crate) id: String,
    pub(crate) slug: String,
    pub(crate) name: String,
    pub(crate) status: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProxyImage {
    pub(crate) id: String,
    pub(crate) ssh_enabled: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProxyContainer {
    pub(crate) id: String,
    pub(crate) owner_id: String,
    pub(crate) server_id: String,
    pub(crate) image_id: String,
    pub(crate) name: String,
    pub(crate) instance_name: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub(crate) struct ProxyRoute {
    pub(crate) container_id: String,
    pub(crate) server_id: String,
    pub(crate) instance_name: String,
    pub(crate) routed_ip: Option<String>,
    pub(crate) status: String,
    pub(crate) ssh_status: String,
    pub(crate) observed_at: String,
}
