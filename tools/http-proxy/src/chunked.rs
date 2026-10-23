//! Strict decoder for `Transfer-Encoding: chunked` request bodies.
//!
//! The body is decoded as it streams and re-chunked with the proxy's own
//! framing, so the upstream never sees client chunk sizes, extensions or
//! trailers. Anything that is not exactly RFC 9112 chunked framing (bare LF,
//! whitespace or signs around the size, oversized sizes or lines, missing
//! CRLF after data, malformed trailers, bytes after the final chunk) is an
//! error, and the final `0` chunk is only written to the upstream once the
//! client's body has been fully validated, so a rejected body always reaches
//! the upstream as an incomplete request.

use crate::config::{MAX_CHUNK_LINE_BYTES, MAX_CHUNK_TRAILER_BYTES};
use crate::request::{invalid_header_value, is_http_token};
use anyhow::{anyhow, Result};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

const READ_BYTES: usize = 16 * 1024;

/// Bytes received from the client but not yet consumed, followed by the
/// socket itself.
struct Source<'a, S> {
    inbound: &'a mut S,
    buffered: Vec<u8>,
    position: usize,
}

impl<S: AsyncRead + Unpin> Source<'_, S> {
    fn pending(&self) -> &[u8] {
        &self.buffered[self.position..]
    }

    async fn fill(&mut self) -> Result<()> {
        self.buffered.drain(..self.position);
        self.position = 0;
        let start = self.buffered.len();
        self.buffered.resize(start + READ_BYTES, 0);
        let n = self.inbound.read(&mut self.buffered[start..]).await?;
        self.buffered.truncate(start + n);
        if n == 0 {
            return Err(anyhow!(
                "client closed the connection inside a chunked request body"
            ));
        }
        Ok(())
    }

    /// One CRLF-terminated line, without the CRLF. A bare LF or CR is an error.
    async fn line(&mut self, max: usize) -> Result<Vec<u8>> {
        loop {
            let pending = self.pending();
            if let Some(end) = pending.iter().position(|byte| *byte == b'\n') {
                if end == 0 || pending[end - 1] != b'\r' {
                    return Err(anyhow!("chunked body line is not CRLF-terminated"));
                }
                let line = pending[..end - 1].to_vec();
                if line.len() > max {
                    return Err(anyhow!("chunked body line is too long"));
                }
                if line.contains(&b'\r') {
                    return Err(anyhow!("chunked body line contains a bare CR"));
                }
                self.position += end + 1;
                return Ok(line);
            }
            if pending.len() > max + 1 {
                return Err(anyhow!("chunked body line is too long"));
            }
            self.fill().await?;
        }
    }

    async fn copy_exact<U: AsyncWrite + Unpin>(
        &mut self,
        upstream: &mut U,
        mut remaining: u64,
    ) -> Result<()> {
        while remaining > 0 {
            if self.pending().is_empty() {
                self.fill().await?;
            }
            let pending = self.pending();
            let take = pending
                .len()
                .min(usize::try_from(remaining).unwrap_or(usize::MAX));
            upstream.write_all(&pending[..take]).await?;
            self.position += take;
            remaining -= take as u64;
        }
        Ok(())
    }
}

/// Parses `chunk-size [ BWS ";" chunk-ext ]`. Extensions are validated for
/// control characters and dropped.
pub(crate) fn parse_chunk_size(line: &[u8]) -> Result<u64> {
    let digits_end = line
        .iter()
        .position(|byte| !byte.is_ascii_hexdigit())
        .unwrap_or(line.len());
    let (digits, rest) = line.split_at(digits_end);
    if digits.is_empty() || digits.len() > 16 {
        return Err(anyhow!("invalid chunk size"));
    }
    if !rest.is_empty() {
        let extension = rest
            .iter()
            .position(|byte| !matches!(byte, b' ' | b'\t'))
            .map(|start| &rest[start..])
            .unwrap_or_default();
        if extension.first() != Some(&b';')
            || extension
                .iter()
                .any(|byte| (*byte < b' ' && *byte != b'\t') || *byte == 0x7f)
        {
            return Err(anyhow!("invalid chunk extension"));
        }
    }
    let digits = std::str::from_utf8(digits).map_err(|_| anyhow!("invalid chunk size"))?;
    u64::from_str_radix(digits, 16).map_err(|_| anyhow!("invalid chunk size"))
}

fn validate_trailer(line: &[u8]) -> Result<()> {
    let line = std::str::from_utf8(line).map_err(|_| anyhow!("malformed chunked trailer"))?;
    let (name, value) = line
        .split_once(':')
        .ok_or_else(|| anyhow!("malformed chunked trailer"))?;
    if !is_http_token(name) || invalid_header_value(value) {
        return Err(anyhow!("malformed chunked trailer"));
    }
    Ok(())
}

/// Forwards a chunked body from `initial` (bytes already read after the
/// request head) and `inbound` to `upstream`, re-chunked, decoding at most
/// `max_body` bytes of data.
pub(crate) async fn forward_chunked_body<S, U>(
    inbound: &mut S,
    upstream: &mut U,
    initial: &[u8],
    max_body: usize,
) -> Result<()>
where
    S: AsyncRead + Unpin,
    U: AsyncWrite + Unpin,
{
    let mut source = Source {
        inbound,
        buffered: initial.to_vec(),
        position: 0,
    };
    let mut total = 0_u64;
    loop {
        let size = parse_chunk_size(&source.line(MAX_CHUNK_LINE_BYTES).await?)?;
        if size == 0 {
            break;
        }
        total = total
            .checked_add(size)
            .filter(|total| *total <= max_body as u64)
            .ok_or_else(|| anyhow!("request body is too large"))?;
        upstream
            .write_all(format!("{size:x}\r\n").as_bytes())
            .await?;
        source.copy_exact(upstream, size).await?;
        if !source.line(0).await?.is_empty() {
            return Err(anyhow!("chunk data is not followed by CRLF"));
        }
        upstream.write_all(b"\r\n").await?;
    }
    let mut trailer_bytes = 0_usize;
    loop {
        let line = source.line(MAX_CHUNK_TRAILER_BYTES).await?;
        if line.is_empty() {
            break;
        }
        trailer_bytes += line.len() + 2;
        if trailer_bytes > MAX_CHUNK_TRAILER_BYTES {
            return Err(anyhow!("chunked trailer section is too large"));
        }
        validate_trailer(&line)?;
    }
    if !source.pending().is_empty() {
        return Err(anyhow!(
            "pipelined or cross-host follow-up request is forbidden"
        ));
    }
    upstream.write_all(b"0\r\n\r\n").await?;
    upstream.flush().await?;
    Ok(())
}

#[cfg(test)]
#[path = "chunked_tests.rs"]
mod tests;
