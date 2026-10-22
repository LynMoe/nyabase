use crate::config::{
    MAX_UPSTREAM_UPGRADE_HEADER_BYTES, UPSTREAM_CONNECT_DEADLINE, UPSTREAM_UPGRADE_HEADER_DEADLINE,
};
use crate::listener::reject;
use crate::relay::relay_with_idle_timeout;
use crate::request::{
    find_header_end, header_has_token, initial_body_bytes_allowed, invalid_header_value,
    is_http_token, RequestMode, RequestPlan,
};
use crate::runtime::Runtime;
use crate::snapshot::Route;
use anyhow::{anyhow, Context, Result};
use std::time::Duration;
use tokio::io::{self, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time;

pub(crate) async fn proxy_request<S: AsyncRead + AsyncWrite + Unpin>(
    inbound: &mut S,
    runtime: &Runtime,
    route: &Route,
    received: Vec<u8>,
    header_end: usize,
    plan: RequestPlan,
) -> Result<()> {
    match plan.mode {
        RequestMode::FixedBody { body_len } => {
            proxy_single_request(
                inbound,
                runtime,
                route,
                received,
                header_end,
                plan.header,
                body_len,
            )
            .await
        }
        RequestMode::WebSocket { expected_accept } => {
            if received.len() != header_end {
                reject(inbound, runtime, "400 Bad Request").await?;
                return Err(anyhow!(
                    "early WebSocket data or a pipelined request is forbidden"
                ));
            }
            proxy_websocket_upgrade(
                inbound,
                runtime,
                route,
                plan.header,
                &expected_accept,
                UPSTREAM_UPGRADE_HEADER_DEADLINE,
            )
            .await
        }
    }
}

pub(crate) async fn proxy_single_request<S: AsyncRead + AsyncWrite + Unpin>(
    inbound: &mut S,
    runtime: &Runtime,
    route: &Route,
    received: Vec<u8>,
    header_end: usize,
    header: Vec<u8>,
    body_len: usize,
) -> Result<()> {
    let initial_body = &received[header_end..];
    if !initial_body_bytes_allowed(body_len, initial_body.len()) {
        reject(inbound, runtime, "400 Bad Request").await?;
        return Err(anyhow!(
            "pipelined or cross-host follow-up request is forbidden"
        ));
    }

    let mut upstream = connect_upstream(inbound, runtime, route).await?;
    // The body is streamed, not buffered, so a connection costs bounded
    // memory; the whole-body budget stops a slow drip from holding the
    // connection and its upstream socket for the full request lifetime.
    match time::timeout(
        runtime.limits.body_deadline,
        forward_request(inbound, &mut upstream, &header, initial_body, body_len),
    )
    .await
    {
        Ok(result) => result?,
        Err(_) => {
            reject(inbound, runtime, "408 Request Timeout").await?;
            return Err(anyhow!("request body deadline exceeded"));
        }
    }
    // Never half-close the upstream here: Node's HTTP server (and others with
    // `allowHalfOpen` off) treats the FIN as an aborted request and drops the
    // response. The request carries `Connection: close`, so the upstream
    // closes once it has answered.
    io::copy(&mut upstream, inbound).await?;
    inbound.shutdown().await?;
    Ok(())
}

async fn forward_request<S, U>(
    inbound: &mut S,
    upstream: &mut U,
    header: &[u8],
    initial_body: &[u8],
    body_len: usize,
) -> Result<()>
where
    S: AsyncRead + Unpin,
    U: AsyncWrite + Unpin,
{
    upstream.write_all(header).await?;
    upstream.write_all(initial_body).await?;
    let remaining = (body_len - initial_body.len()) as u64;
    if remaining > 0 {
        let copied = io::copy(&mut (&mut *inbound).take(remaining), upstream).await?;
        if copied != remaining {
            return Err(anyhow!(
                "client closed the connection before sending the full request body"
            ));
        }
    }
    upstream.flush().await?;
    Ok(())
}

pub(crate) async fn connect_upstream<S: AsyncWrite + Unpin>(
    inbound: &mut S,
    runtime: &Runtime,
    route: &Route,
) -> Result<TcpStream> {
    let upstream_addr = format!("{}:{}", route.routed_ip, route.target_port);
    match time::timeout(
        UPSTREAM_CONNECT_DEADLINE,
        TcpStream::connect(&upstream_addr),
    )
    .await
    {
        Ok(Ok(stream)) => Ok(stream),
        Ok(Err(error)) => {
            reject(inbound, runtime, "503 Service Unavailable").await?;
            Err(error.into())
        }
        Err(_) => {
            reject(inbound, runtime, "503 Service Unavailable").await?;
            Err(anyhow!("upstream connection deadline exceeded"))
        }
    }
}

pub(crate) async fn proxy_websocket_upgrade<S: AsyncRead + AsyncWrite + Unpin>(
    inbound: &mut S,
    runtime: &Runtime,
    route: &Route,
    header: Vec<u8>,
    expected_accept: &str,
    response_deadline: Duration,
) -> Result<()> {
    let mut upstream = connect_upstream(inbound, runtime, route).await?;
    upstream.write_all(&header).await?;
    let response = match time::timeout(response_deadline, read_response_head(&mut upstream)).await {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => {
            reject(inbound, runtime, "502 Bad Gateway").await?;
            return Err(error);
        }
        Err(_) => {
            reject(inbound, runtime, "504 Gateway Timeout").await?;
            return Err(anyhow!("upstream WebSocket response deadline exceeded"));
        }
    };
    let Some(response_header_end) = find_header_end(&response) else {
        reject(inbound, runtime, "502 Bad Gateway").await?;
        return Err(anyhow!("upstream WebSocket response is incomplete"));
    };
    if let Err(error) =
        validate_websocket_response(&response[..response_header_end], expected_accept)
    {
        reject(inbound, runtime, "502 Bad Gateway").await?;
        return Err(error);
    }
    inbound.write_all(&response).await?;
    relay_with_idle_timeout(inbound, &mut upstream, runtime.limits.upgraded_idle).await
}

pub(crate) async fn read_response_head<S: AsyncRead + Unpin>(upstream: &mut S) -> Result<Vec<u8>> {
    let mut head = Vec::with_capacity(1024);
    let mut buf = [0_u8; 1024];
    loop {
        let n = upstream.read(&mut buf).await?;
        if n == 0 {
            return Ok(head);
        }
        head.extend_from_slice(&buf[..n]);
        if let Some(header_end) = find_header_end(&head) {
            if header_end > MAX_UPSTREAM_UPGRADE_HEADER_BYTES {
                return Err(anyhow!("upstream WebSocket response header is too large"));
            }
            return Ok(head);
        }
        if head.len() > MAX_UPSTREAM_UPGRADE_HEADER_BYTES {
            return Err(anyhow!("upstream WebSocket response header is too large"));
        }
    }
}

pub(crate) fn validate_websocket_response(header: &[u8], expected_accept: &str) -> Result<()> {
    let text = std::str::from_utf8(header).context("upstream WebSocket response is not UTF-8")?;
    let mut lines = text.split("\r\n");
    let status = lines.next().context("missing upstream response status")?;
    let mut status_parts = status.splitn(3, ' ');
    if status_parts.next() != Some("HTTP/1.1") || status_parts.next() != Some("101") {
        return Err(anyhow!("upstream did not accept the WebSocket upgrade"));
    }
    let mut connection = None;
    let mut upgrade = None;
    let mut accept = None;
    for line in lines {
        if line.is_empty() {
            break;
        }
        let (name, value) = line
            .split_once(':')
            .context("malformed upstream WebSocket response header")?;
        if !is_http_token(name) || invalid_header_value(value) {
            return Err(anyhow!("malformed upstream WebSocket response header"));
        }
        if name.eq_ignore_ascii_case("content-length")
            || name.eq_ignore_ascii_case("transfer-encoding")
        {
            return Err(anyhow!(
                "upstream WebSocket response contains a forbidden body framing header"
            ));
        }
        if name.eq_ignore_ascii_case("connection")
            && connection.replace(value.trim().to_string()).is_some()
        {
            return Err(anyhow!("duplicate upstream Connection header"));
        }
        if name.eq_ignore_ascii_case("upgrade")
            && upgrade.replace(value.trim().to_string()).is_some()
        {
            return Err(anyhow!("duplicate upstream Upgrade header"));
        }
        if name.eq_ignore_ascii_case("sec-websocket-accept")
            && accept.replace(value.trim().to_string()).is_some()
        {
            return Err(anyhow!("duplicate upstream Sec-WebSocket-Accept header"));
        }
    }
    if !header_has_token(
        connection
            .as_deref()
            .context("upstream Connection header is missing")?,
        "upgrade",
    )? {
        return Err(anyhow!("upstream Connection upgrade token is missing"));
    }
    if upgrade
        .as_deref()
        .is_none_or(|value| !value.eq_ignore_ascii_case("websocket"))
    {
        return Err(anyhow!("upstream Upgrade header is not websocket"));
    }
    if accept.as_deref() != Some(expected_accept) {
        return Err(anyhow!("upstream Sec-WebSocket-Accept is invalid"));
    }
    Ok(())
}

#[cfg(test)]
#[path = "upstream_tests.rs"]
mod tests;
