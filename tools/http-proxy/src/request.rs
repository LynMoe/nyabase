use crate::config::{MAX_REQUEST_BODY_BYTES, MAX_REQUEST_HEADER_BYTES};
use anyhow::{anyhow, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use tokio::io::{AsyncRead, AsyncReadExt};

pub(crate) async fn read_request_head<S: AsyncRead + Unpin>(inbound: &mut S) -> Result<Vec<u8>> {
    let mut head = Vec::with_capacity(4096);
    let mut buf = [0_u8; 1024];
    loop {
        let n = inbound.read(&mut buf).await?;
        if n == 0 {
            return Ok(head);
        }
        head.extend_from_slice(&buf[..n]);
        if let Some(header_end) = find_header_end(&head) {
            if header_end > MAX_REQUEST_HEADER_BYTES {
                return Err(anyhow!("request header is too large"));
            }
            return Ok(head);
        }
        if head.len() > MAX_REQUEST_HEADER_BYTES {
            return Err(anyhow!("request header is too large"));
        }
    }
}

pub(crate) fn find_header_end(bytes: &[u8]) -> Option<usize> {
    bytes
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|offset| offset + 4)
}

pub(crate) struct RequestPlan {
    pub(crate) host: String,
    pub(crate) header: Vec<u8>,
    pub(crate) mode: RequestMode,
}

pub(crate) enum RequestMode {
    FixedBody { body_len: usize },
    WebSocket { expected_accept: String },
}

pub(crate) fn request_plan(header: &[u8]) -> Result<RequestPlan> {
    let text = std::str::from_utf8(header).context("request header is not UTF-8")?;
    let mut lines = text.split("\r\n");
    let request_line = lines
        .next()
        .filter(|line| !line.is_empty())
        .context("missing request line")?;
    let request_parts = request_line.split_whitespace().collect::<Vec<_>>();
    if request_parts.len() != 3
        || !is_http_token(request_parts[0])
        || !(request_parts[1].starts_with('/') || request_parts[1] == "*")
        || !matches!(request_parts[2], "HTTP/1.0" | "HTTP/1.1")
    {
        return Err(anyhow!("malformed or unsupported HTTP request line"));
    }
    if request_parts[0].eq_ignore_ascii_case("CONNECT") {
        return Err(anyhow!("CONNECT tunneling is disabled"));
    }
    let mut content_length = None;
    let mut host_count = 0;
    let mut host = None;
    let mut connection = None;
    let mut upgrade = None;
    let mut websocket_key = None;
    let mut websocket_version = None;
    let mut websocket_protocol_seen = false;
    let mut websocket_extensions_seen = false;
    let mut websocket_header_seen = false;
    let mut rewritten = format!("{request_line}\r\n");
    for line in lines {
        if line.is_empty() {
            break;
        }
        let (name, value) = line.split_once(':').context("malformed request header")?;
        if !is_http_token(name) {
            return Err(anyhow!("malformed request header name"));
        }
        if invalid_header_value(value) {
            return Err(anyhow!("malformed request header value"));
        }
        if name.eq_ignore_ascii_case("host") {
            host_count += 1;
            host = Some(normalize_host_authority(value)?);
        }
        if name.eq_ignore_ascii_case("transfer-encoding") || name.eq_ignore_ascii_case("expect") {
            return Err(anyhow!("streaming request bodies are disabled"));
        }
        if name.eq_ignore_ascii_case("content-length") {
            if content_length.is_some() {
                return Err(anyhow!("duplicate Content-Length header"));
            }
            let value = value.trim();
            if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err(anyhow!("invalid Content-Length"));
            }
            let parsed = value.parse::<usize>().context("invalid Content-Length")?;
            if parsed > MAX_REQUEST_BODY_BYTES {
                return Err(anyhow!("request body is too large"));
            }
            content_length = Some(parsed);
        }
        if name.eq_ignore_ascii_case("connection") {
            if connection.replace(value.trim().to_string()).is_some() {
                return Err(anyhow!("duplicate Connection header"));
            }
            continue;
        }
        if name.eq_ignore_ascii_case("upgrade") {
            if upgrade.replace(value.trim().to_string()).is_some() {
                return Err(anyhow!("duplicate Upgrade header"));
            }
            websocket_header_seen = true;
            continue;
        }
        if name.eq_ignore_ascii_case("sec-websocket-key") {
            if websocket_key.replace(value.trim().to_string()).is_some() {
                return Err(anyhow!("duplicate Sec-WebSocket-Key header"));
            }
            websocket_header_seen = true;
        }
        if name.eq_ignore_ascii_case("sec-websocket-version") {
            if websocket_version
                .replace(value.trim().to_string())
                .is_some()
            {
                return Err(anyhow!("duplicate Sec-WebSocket-Version header"));
            }
            websocket_header_seen = true;
        }
        if name.eq_ignore_ascii_case("sec-websocket-protocol") {
            if websocket_protocol_seen {
                return Err(anyhow!("duplicate Sec-WebSocket-Protocol header"));
            }
            websocket_protocol_seen = true;
            websocket_header_seen = true;
        }
        if name.eq_ignore_ascii_case("sec-websocket-extensions") {
            if websocket_extensions_seen {
                return Err(anyhow!("duplicate Sec-WebSocket-Extensions header"));
            }
            websocket_extensions_seen = true;
            websocket_header_seen = true;
        }
        if name.eq_ignore_ascii_case("sec-websocket-accept") {
            return Err(anyhow!(
                "Sec-WebSocket-Accept is forbidden in a client request"
            ));
        }
        if name.eq_ignore_ascii_case("proxy-connection") || name.eq_ignore_ascii_case("keep-alive")
        {
            continue;
        }
        rewritten.push_str(line);
        rewritten.push_str("\r\n");
    }
    if host_count != 1 {
        return Err(anyhow!("exactly one Host header is required"));
    }
    let connection_has_upgrade = match connection.as_deref() {
        Some(value) => header_has_token(value, "upgrade")?,
        None => false,
    };
    let websocket_intent = websocket_header_seen || upgrade.is_some() || connection_has_upgrade;
    let mode = if websocket_intent {
        if request_parts[0] != "GET"
            || request_parts[2] != "HTTP/1.1"
            || !request_parts[1].starts_with('/')
        {
            return Err(anyhow!("WebSocket upgrade requires GET over HTTP/1.1"));
        }
        if content_length.is_some() {
            return Err(anyhow!("WebSocket upgrade must not include Content-Length"));
        }
        if !connection_has_upgrade {
            return Err(anyhow!("WebSocket Connection token is missing"));
        }
        if upgrade
            .as_deref()
            .is_none_or(|value| !value.eq_ignore_ascii_case("websocket"))
        {
            return Err(anyhow!("only a WebSocket Upgrade is supported"));
        }
        if websocket_version.as_deref() != Some("13") {
            return Err(anyhow!("only WebSocket version 13 is supported"));
        }
        let key = websocket_key.context("Sec-WebSocket-Key is required")?;
        let decoded = BASE64_STANDARD
            .decode(key.as_bytes())
            .map_err(|_| anyhow!("Sec-WebSocket-Key is invalid"))?;
        if decoded.len() != 16 {
            return Err(anyhow!("Sec-WebSocket-Key is invalid"));
        }
        rewritten.push_str("Upgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
        RequestMode::WebSocket {
            expected_accept: tokio_tungstenite::tungstenite::handshake::derive_accept_key(
                key.as_bytes(),
            ),
        }
    } else {
        rewritten.push_str("Connection: close\r\n\r\n");
        RequestMode::FixedBody {
            body_len: content_length.unwrap_or(0),
        }
    };
    Ok(RequestPlan {
        host: host.context("Host header is empty or invalid")?,
        header: rewritten.into_bytes(),
        mode,
    })
}

pub(crate) fn header_has_token(value: &str, expected: &str) -> Result<bool> {
    let mut found = false;
    for token in value.split(',') {
        let token = token.trim();
        if !is_http_token(token) {
            return Err(anyhow!("malformed comma-separated header token"));
        }
        found |= token.eq_ignore_ascii_case(expected);
    }
    Ok(found)
}

pub(crate) fn invalid_header_value(value: &str) -> bool {
    value
        .bytes()
        .any(|byte| (byte < b' ' && byte != b'\t') || byte == 0x7f)
}

pub(crate) fn initial_body_bytes_allowed(
    content_length: usize,
    received_after_header: usize,
) -> bool {
    received_after_header <= content_length
}

pub(crate) fn is_http_token(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(
                    byte,
                    b'!' | b'#'
                        | b'$'
                        | b'%'
                        | b'&'
                        | b'\''
                        | b'*'
                        | b'+'
                        | b'-'
                        | b'.'
                        | b'^'
                        | b'_'
                        | b'`'
                        | b'|'
                        | b'~'
                )
        })
}

pub(crate) fn normalize_host_authority(value: &str) -> Result<String> {
    let authority = value.trim();
    if authority.is_empty()
        || !authority.is_ascii()
        || authority
            .bytes()
            .any(|byte| byte.is_ascii_whitespace() || matches!(byte, b'/' | b'\\' | b'@'))
    {
        return Err(anyhow!("invalid Host authority"));
    }
    let mut parts = authority.split(':');
    let hostname = parts.next().unwrap_or("").trim_end_matches('.');
    if let Some(port) = parts.next() {
        if parts.next().is_some()
            || port.is_empty()
            || !port.bytes().all(|byte| byte.is_ascii_digit())
            || port.parse::<u16>().ok().filter(|port| *port > 0).is_none()
        {
            return Err(anyhow!("invalid Host port"));
        }
    }
    if hostname.is_empty()
        || hostname.starts_with('.')
        || hostname.contains("..")
        || !hostname
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
    {
        return Err(anyhow!("invalid Host name"));
    }
    Ok(hostname.to_ascii_lowercase())
}

#[cfg(test)]
#[path = "request_tests.rs"]
mod tests;
