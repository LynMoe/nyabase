//! PROXY protocol (v1 text / v2 binary) on the public listener.
//!
//! A TCP relay in front of the proxy (frp, nginx `stream`, haproxy, a load
//! balancer) replaces the client's address with its own; when it prepends a
//! PROXY header, the address in that header is the client. Only connections
//! whose socket peer is in `NYABASE_SSH_PROXY_PROTOCOL_TRUSTED` are read for
//! a header: from anywhere else a header is just bytes before the SSH banner,
//! so nobody can claim another address. A trusted peer may also connect
//! without a header (e.g. a LAN client inside the trusted range), which is
//! told apart by the first byte: an SSH identification starts with `S`, a v1
//! header with `P` and a v2 header with `\r`.

use anyhow::{anyhow, bail, Context, Result};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;
use tokio::io::AsyncReadExt as _;
use tokio::net::TcpStream;

pub(crate) const PROXY_PROTOCOL_TRUSTED_ENV: &str = "NYABASE_SSH_PROXY_PROTOCOL_TRUSTED";

/// From accept to a complete header; a relay writes it with its first bytes.
pub(crate) const PROXY_HEADER_TIMEOUT: Duration = Duration::from_secs(3);

const V2_SIGNATURE: [u8; 12] = *b"\r\n\r\n\0\r\nQUIT\n";

/// "PROXY TCP6 <39> <39> 65535 65535\r\n" is the longest v1 line.
const V1_MAX_LINE: usize = 107;

/// Peer networks allowed to send a PROXY header.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct TrustedSources(Vec<Cidr>);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct Cidr {
    network: IpAddr,
    prefix: u8,
}

impl TrustedSources {
    /// Comma- or whitespace-separated addresses and CIDR networks; empty
    /// trusts nobody.
    pub(crate) fn parse(value: &str) -> Result<Self> {
        value
            .split(|c: char| c == ',' || c.is_whitespace())
            .filter(|entry| !entry.is_empty())
            .map(Cidr::parse)
            .collect::<Result<Vec<_>>>()
            .map(Self)
            .with_context(|| format!("invalid {PROXY_PROTOCOL_TRUSTED_ENV}"))
    }

    pub(crate) fn from_env() -> Result<Self> {
        match std::env::var(PROXY_PROTOCOL_TRUSTED_ENV) {
            Ok(value) => Self::parse(&value),
            Err(std::env::VarError::NotPresent) => Ok(Self::default()),
            Err(error) => {
                Err(error).with_context(|| format!("failed to read {PROXY_PROTOCOL_TRUSTED_ENV}"))
            }
        }
    }

    pub(crate) fn contains(&self, ip: IpAddr) -> bool {
        let ip = canonical(ip);
        self.0.iter().any(|cidr| cidr.contains(ip))
    }
}

impl std::fmt::Display for TrustedSources {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        for (index, cidr) in self.0.iter().enumerate() {
            let separator = if index == 0 { "" } else { "," };
            write!(f, "{separator}{}/{}", cidr.network, cidr.prefix)?;
        }
        Ok(())
    }
}

impl Cidr {
    fn parse(entry: &str) -> Result<Self> {
        let (address, prefix) = match entry.split_once('/') {
            Some((address, prefix)) => (address, Some(prefix)),
            None => (entry, None),
        };
        let network = canonical(
            address
                .parse::<IpAddr>()
                .map_err(|_| anyhow!("`{entry}` is not an IP address or CIDR network"))?,
        );
        let bits = if network.is_ipv4() { 32 } else { 128 };
        let prefix = match prefix {
            Some(prefix) => prefix
                .parse::<u8>()
                .ok()
                .filter(|prefix| *prefix <= bits)
                .ok_or_else(|| anyhow!("`{entry}` has an invalid prefix length"))?,
            None => bits,
        };
        let cidr = Self { network, prefix };
        if cidr.masked(network) != network {
            bail!("`{entry}` has host bits set");
        }
        Ok(cidr)
    }

    fn contains(&self, ip: IpAddr) -> bool {
        ip.is_ipv4() == self.network.is_ipv4() && self.masked(ip) == self.network
    }

    fn masked(&self, ip: IpAddr) -> IpAddr {
        match ip {
            IpAddr::V4(v4) => {
                let mask = u32::MAX
                    .checked_shl(32 - u32::from(self.prefix))
                    .unwrap_or(0);
                IpAddr::V4(Ipv4Addr::from(u32::from(v4) & mask))
            }
            IpAddr::V6(v6) => {
                let mask = u128::MAX
                    .checked_shl(128 - u32::from(self.prefix))
                    .unwrap_or(0);
                IpAddr::V6(Ipv6Addr::from(u128::from(v6) & mask))
            }
        }
    }
}

/// IPv4-mapped IPv6 (a dual-stack listener's view of an IPv4 peer) counts
/// as the IPv4 address it carries.
fn canonical(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(ip, IpAddr::V4),
        IpAddr::V4(_) => ip,
    }
}

fn client(ip: IpAddr, port: u16) -> SocketAddr {
    SocketAddr::new(canonical(ip), port)
}

/// Reads the PROXY header a trusted `peer` may have sent and returns the
/// client it names; `peer` itself when there is no header, or when the
/// header carries no address (v2 `LOCAL` health checks, v1 `UNKNOWN`). A
/// malformed or incomplete header fails the connection.
pub(crate) async fn read_client_address(
    stream: &mut TcpStream,
    peer: SocketAddr,
    timeout: Duration,
) -> Result<SocketAddr> {
    let deadline = tokio::time::Instant::now() + timeout;
    let mut first = [0_u8; 1];
    // A client that waits for the server's banner sends nothing; it gets
    // one after the timeout, like any connection without a header.
    let Ok(peeked) = tokio::time::timeout_at(deadline, stream.peek(&mut first)).await else {
        return Ok(peer);
    };
    if peeked? == 0 {
        return Ok(peer);
    }
    let header = match first[0] {
        b'P' => tokio::time::timeout_at(deadline, read_v1(stream)).await,
        b'\r' => tokio::time::timeout_at(deadline, read_v2(stream)).await,
        _ => return Ok(peer),
    };
    let header = header.map_err(|_| anyhow!("PROXY header not completed within the timeout"))??;
    Ok(header.unwrap_or(peer))
}

async fn read_v1(stream: &mut TcpStream) -> Result<Option<SocketAddr>> {
    // Byte by byte so nothing after the header (the SSH banner) is consumed.
    let mut line = Vec::with_capacity(V1_MAX_LINE);
    while !line.ends_with(b"\r\n") {
        if line.len() == V1_MAX_LINE {
            bail!("PROXY v1 header longer than {V1_MAX_LINE} bytes");
        }
        line.push(stream.read_u8().await?);
    }
    parse_v1(&line[..line.len() - 2])
}

async fn read_v2(stream: &mut TcpStream) -> Result<Option<SocketAddr>> {
    let mut fixed = [0_u8; 16];
    stream.read_exact(&mut fixed).await?;
    let mut body = vec![0_u8; usize::from(u16::from_be_bytes([fixed[14], fixed[15]]))];
    stream.read_exact(&mut body).await?;
    parse_v2(&fixed, &body)
}

/// `line` without its CRLF.
pub(crate) fn parse_v1(line: &[u8]) -> Result<Option<SocketAddr>> {
    let line = std::str::from_utf8(line).map_err(|_| anyhow!("PROXY v1 header is not ASCII"))?;
    let mut fields = line.split(' ');
    if fields.next() != Some("PROXY") {
        bail!("not a PROXY v1 header");
    }
    let family = fields
        .next()
        .ok_or_else(|| anyhow!("PROXY v1 header has no protocol"))?;
    if family == "UNKNOWN" {
        return Ok(None);
    }
    let fields: Vec<&str> = fields.collect();
    let [source, destination, source_port, destination_port] = fields[..] else {
        bail!("PROXY v1 header needs four address fields");
    };
    let parse_ip = |text: &str| -> Result<IpAddr> {
        let ip = match family {
            "TCP4" => text.parse::<Ipv4Addr>().map(IpAddr::V4),
            "TCP6" => text.parse::<Ipv6Addr>().map(IpAddr::V6),
            _ => bail!("PROXY v1 protocol `{family}` is not supported"),
        };
        ip.map_err(|_| anyhow!("PROXY v1 address `{text}` is not a {family} address"))
    };
    let parse_port = |text: &str| -> Result<u16> {
        // Decimal without leading zeros, as the specification requires.
        if text.is_empty() || (text.len() > 1 && text.starts_with('0')) {
            bail!("PROXY v1 port `{text}` is invalid");
        }
        text.parse()
            .map_err(|_| anyhow!("PROXY v1 port `{text}` is invalid"))
    };
    let source = parse_ip(source)?;
    parse_ip(destination)?;
    let source_port = parse_port(source_port)?;
    parse_port(destination_port)?;
    Ok(Some(client(source, source_port)))
}

/// `fixed` is the 16-byte preamble, `body` the `len` bytes after it.
pub(crate) fn parse_v2(fixed: &[u8; 16], body: &[u8]) -> Result<Option<SocketAddr>> {
    if fixed[..12] != V2_SIGNATURE {
        bail!("not a PROXY v2 header");
    }
    let version = fixed[12] >> 4;
    let command = fixed[12] & 0x0f;
    if version != 2 {
        bail!("PROXY v2 header has version {version}");
    }
    match command {
        // LOCAL: the relay's own connection (health check); no client.
        0x0 => return Ok(None),
        0x1 => {}
        _ => bail!("PROXY v2 command {command} is not supported"),
    }
    let ip_port = |ip: IpAddr, port: &[u8]| client(ip, u16::from_be_bytes([port[0], port[1]]));
    // Only the source address and port matter; TLVs after them are ignored.
    match fixed[13] >> 4 {
        0x1 => {
            let addresses = body
                .get(..12)
                .ok_or_else(|| anyhow!("PROXY v2 IPv4 addresses are truncated"))?;
            let source: [u8; 4] = addresses[..4].try_into().unwrap();
            Ok(Some(ip_port(IpAddr::from(source), &addresses[8..10])))
        }
        0x2 => {
            let addresses = body
                .get(..36)
                .ok_or_else(|| anyhow!("PROXY v2 IPv6 addresses are truncated"))?;
            let source: [u8; 16] = addresses[..16].try_into().unwrap();
            Ok(Some(ip_port(IpAddr::from(source), &addresses[32..34])))
        }
        // UNSPEC / AF_UNIX: the receiver uses the connection's own address.
        0x0 | 0x3 => Ok(None),
        family => bail!("PROXY v2 address family {family} is not supported"),
    }
}

#[cfg(test)]
#[path = "proxy_protocol_tests.rs"]
mod tests;
