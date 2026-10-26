//! Backend WebSocket URL validation and backend CA trust configuration.

use std::fs::OpenOptions;
use std::io::{BufReader, Read};
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use rustls::pki_types::pem::{self, SectionKind};
use rustls::pki_types::CertificateDer;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

const MAX_BACKEND_CA_PEM_BYTES: u64 = 1024 * 1024;

/// The control link carries the proxy bearer token and every routing
/// snapshot (including TLS private keys), so it must be encrypted unless the
/// Backend is reached over loopback (same host, or an `ssh -R` tunnel).
pub fn validate_backend_ws_url(value: &str, has_custom_ca: bool) -> Result<()> {
    let request = value
        .into_client_request()
        .context("NYABASE_BACKEND_WS is not a valid WebSocket URL")?;
    let uri = request.uri();
    match uri.scheme_str() {
        Some("wss") => Ok(()),
        Some("ws") if has_custom_ca => {
            anyhow::bail!("NYABASE_BACKEND_CA_FILE requires a wss:// Backend URL")
        }
        Some("ws") if uri.host().is_some_and(is_loopback_host) => Ok(()),
        Some("ws") => {
            anyhow::bail!("NYABASE_BACKEND_WS must use wss:// unless the Backend host is loopback")
        }
        _ => anyhow::bail!("NYABASE_BACKEND_WS must use wss:// (or ws:// to a loopback host)"),
    }
}

/// `localhost`, `127.0.0.0/8` or `::1` (bracketed or not).
pub fn is_loopback_host(host: &str) -> bool {
    let host = host
        .strip_prefix('[')
        .and_then(|inner| inner.strip_suffix(']'))
        .unwrap_or(host);
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
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
    while let Some((kind, der)) =
        pem::from_buf(&mut reader).map_err(|_| anyhow::anyhow!("{name} contains invalid PEM"))?
    {
        if kind != SectionKind::Certificate {
            anyhow::bail!("{name} may contain only CA certificates");
        }
        roots
            .add(CertificateDer::from(der))
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
    fn plain_ws_is_only_allowed_to_a_loopback_backend() {
        for allowed in [
            "ws://127.0.0.1:3000/ws/ssh-proxy",
            "ws://127.8.9.10:3001/ws/http-proxy",
            "ws://localhost:3000/ws/ssh-proxy",
            "ws://LOCALHOST/ws/ssh-proxy",
            "ws://[::1]:3000/ws/http-proxy",
        ] {
            assert!(validate_backend_ws_url(allowed, false).is_ok(), "{allowed}");
        }
        for rejected in [
            "ws://backend.example/ws/ssh-proxy",
            "ws://10.0.0.5:3001/ws/ssh-proxy",
            "ws://[::2]:3000/ws/http-proxy",
            "ws://localhost.evil.example/ws/ssh-proxy",
            "ws://127.0.0.1.nip.io/ws/ssh-proxy",
            "ws://0.0.0.0:3000/ws/ssh-proxy",
        ] {
            let error = validate_backend_ws_url(rejected, false).unwrap_err();
            assert!(error.to_string().contains("wss://"), "{rejected}: {error}");
        }
        // A custom CA only makes sense with TLS, even on loopback.
        assert!(validate_backend_ws_url("ws://127.0.0.1:3000/ws/ssh-proxy", true).is_err());
    }

    #[test]
    fn backend_ca_is_explicit() {
        assert!(validate_backend_ws_url("wss://backend.example/ws/ssh-proxy", false).is_ok());
        assert!(validate_backend_ws_url("wss://backend.example/ws/ssh-proxy", true).is_ok());
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
