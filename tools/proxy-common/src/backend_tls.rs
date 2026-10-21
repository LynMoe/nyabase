//! Backend WebSocket URL validation and backend CA trust configuration.

use std::fs::OpenOptions;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

const MAX_BACKEND_CA_PEM_BYTES: u64 = 1024 * 1024;

pub fn validate_backend_ws_url(value: &str, has_custom_ca: bool) -> Result<()> {
    let request = value
        .into_client_request()
        .context("NYABASE_BACKEND_WS is not a valid WebSocket URL")?;
    match request.uri().scheme_str() {
        Some("wss") => Ok(()),
        Some("ws") if !has_custom_ca => Ok(()),
        Some("ws") => anyhow::bail!("NYABASE_BACKEND_CA_FILE requires a wss:// Backend URL"),
        _ => anyhow::bail!("NYABASE_BACKEND_WS must use ws:// or wss://"),
    }
}

pub fn backend_tls_config_from_env(name: &str) -> Result<Option<Arc<rustls::ClientConfig>>> {
    let Some(path) = std::env::var_os(name).map(PathBuf::from) else {
        return Ok(None);
    };
    if path.as_os_str().is_empty() {
        anyhow::bail!("{name} must not be empty when configured");
    }
    let pem = read_bounded_ca_file(name, &path)?;
    Ok(Some(backend_tls_config_from_pem(name, &pem)?))
}

pub fn read_bounded_ca_file(name: &str, path: &Path) -> Result<Vec<u8>> {
    let file = OpenOptions::new()
        .read(true)
        .open(path)
        .with_context(|| format!("failed to open {name}"))?;
    let metadata = file
        .metadata()
        .with_context(|| format!("failed to inspect {name}"))?;
    if !metadata.is_file() {
        anyhow::bail!("{name} must reference a regular file");
    }
    if metadata.len() == 0 || metadata.len() > MAX_BACKEND_CA_PEM_BYTES {
        anyhow::bail!("{name} must contain a non-empty bounded PEM bundle");
    }
    let mut pem = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_BACKEND_CA_PEM_BYTES + 1)
        .read_to_end(&mut pem)
        .with_context(|| format!("failed to read {name}"))?;
    if pem.is_empty() || pem.len() as u64 > MAX_BACKEND_CA_PEM_BYTES {
        anyhow::bail!("{name} must contain a non-empty bounded PEM bundle");
    }
    Ok(pem)
}

pub fn backend_tls_config_from_pem(name: &str, pem: &[u8]) -> Result<Arc<rustls::ClientConfig>> {
    if pem.is_empty() {
        anyhow::bail!("{name} contains no CA certificates");
    }
    let mut reader = BufReader::new(pem);
    let mut roots = rustls::RootCertStore::empty();
    let mut certificates = 0usize;
    for item in rustls_pemfile::read_all(&mut reader) {
        let item = item.map_err(|_| anyhow::anyhow!("{name} contains invalid PEM"))?;
        let rustls_pemfile::Item::X509Certificate(certificate) = item else {
            anyhow::bail!("{name} may contain only CA certificates");
        };
        roots
            .add(certificate)
            .map_err(|_| anyhow::anyhow!("{name} contains an invalid CA certificate"))?;
        certificates += 1;
    }
    if certificates == 0 {
        anyhow::bail!("{name} contains no CA certificates");
    }
    Ok(Arc::new(
        rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .context("failed to select secure Backend TLS protocol versions")?
        .with_root_certificates(roots)
        .with_no_client_auth(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_ca_is_explicit_and_plain_ws_remains_compatible_without_it() {
        assert!(validate_backend_ws_url("wss://backend.example/ws/ssh-proxy", false).is_ok());
        assert!(validate_backend_ws_url("wss://backend.example/ws/ssh-proxy", true).is_ok());
        assert!(validate_backend_ws_url("ws://backend.example/ws/ssh-proxy", false).is_ok());
        assert!(validate_backend_ws_url("ws://backend.example/ws/ssh-proxy", true).is_err());
        assert!(validate_backend_ws_url("http://backend.example/ws/ssh-proxy", false).is_err());
        assert!(backend_tls_config_from_pem(
            "NYABASE_BACKEND_CA_FILE",
            include_bytes!("../tests/fixtures/test-ca.pem"),
        )
        .is_ok());
        assert!(backend_tls_config_from_pem("NYABASE_BACKEND_CA_FILE", b"").is_err());
        assert!(
            backend_tls_config_from_pem("NYABASE_BACKEND_CA_FILE", b"not a PEM bundle").is_err()
        );
        assert!(backend_tls_config_from_pem(
            "NYABASE_BACKEND_CA_FILE",
            b"-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----\n",
        )
        .is_err());
    }
}
