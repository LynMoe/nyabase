use super::*;
use tokio::io::AsyncWriteExt as _;
use tokio::net::TcpListener;

const TEST_TIMEOUT: Duration = Duration::from_millis(200);

fn v2(command: u8, family: u8, body: &[u8]) -> ([u8; 16], Vec<u8>) {
    let mut fixed = [0_u8; 16];
    fixed[..12].copy_from_slice(&V2_SIGNATURE);
    fixed[12] = 0x20 | command;
    fixed[13] = family;
    fixed[14..].copy_from_slice(&(body.len() as u16).to_be_bytes());
    (fixed, body.to_vec())
}

fn v2_tcp4(source: [u8; 4], source_port: u16) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&source);
    body.extend_from_slice(&[10, 8, 16, 31]);
    body.extend_from_slice(&source_port.to_be_bytes());
    body.extend_from_slice(&2222_u16.to_be_bytes());
    body
}

#[test]
fn trusted_sources_parse_addresses_and_networks() {
    let trusted = TrustedSources::parse("10.8.0.0/16, 192.0.2.7 2001:db8::/32").unwrap();
    assert_eq!(
        trusted.to_string(),
        "10.8.0.0/16,192.0.2.7/32,2001:db8::/32"
    );
    assert!(trusted.contains("10.8.16.1".parse().unwrap()));
    assert!(trusted.contains("::ffff:10.8.0.9".parse().unwrap()));
    assert!(trusted.contains("192.0.2.7".parse().unwrap()));
    assert!(!trusted.contains("192.0.2.8".parse().unwrap()));
    assert!(trusted.contains("2001:db8:1::1".parse().unwrap()));
    assert!(!trusted.contains("2001:db9::1".parse().unwrap()));
    assert!(!trusted.contains("10.9.0.1".parse().unwrap()));
    assert!(TrustedSources::parse("0.0.0.0/0")
        .unwrap()
        .contains("203.0.113.1".parse().unwrap()));

    let nobody = TrustedSources::parse(" , ").unwrap();
    assert!(!nobody.contains("127.0.0.1".parse().unwrap()));
    for invalid in [
        "10.8.0.1/16",
        "10.8.0.0/33",
        "host.example",
        "10.8.0.0/",
        "::/129",
    ] {
        let error = TrustedSources::parse(invalid).unwrap_err();
        assert!(
            format!("{error:#}").contains(PROXY_PROTOCOL_TRUSTED_ENV),
            "{invalid}"
        );
    }
}

#[test]
fn v1_headers_name_the_source_or_nothing() {
    assert_eq!(
        parse_v1(b"PROXY TCP4 203.0.113.9 10.8.16.31 51234 2222").unwrap(),
        Some("203.0.113.9:51234".parse().unwrap())
    );
    assert_eq!(
        parse_v1(b"PROXY TCP6 2001:db8::5 2001:db8::1 40000 2222").unwrap(),
        Some("[2001:db8::5]:40000".parse().unwrap())
    );
    assert_eq!(
        parse_v1(b"PROXY TCP6 ::ffff:203.0.113.9 ::ffff:10.8.16.31 1 2").unwrap(),
        Some("203.0.113.9:1".parse().unwrap())
    );
    assert_eq!(parse_v1(b"PROXY UNKNOWN").unwrap(), None);
    assert_eq!(
        parse_v1(b"PROXY UNKNOWN ffff::1 ffff::2 1 2").unwrap(),
        None
    );
    for invalid in [
        &b"PROXY TCP4 2001:db8::5 10.8.16.31 1 2"[..],
        b"PROXY TCP4 203.0.113.9 10.8.16.31 051234 2222",
        b"PROXY TCP4 203.0.113.9 10.8.16.31 65536 2222",
        b"PROXY TCP4 203.0.113.9 10.8.16.31 1",
        b"PROXY TCP4 203.0.113.9 10.8.16.31 1 2 3",
        b"PROXY UDP4 203.0.113.9 10.8.16.31 1 2",
        b"PROXY  TCP4 203.0.113.9 10.8.16.31 1 2",
        b"PROXZ TCP4 203.0.113.9 10.8.16.31 1 2",
    ] {
        assert!(
            parse_v1(invalid).is_err(),
            "{}",
            String::from_utf8_lossy(invalid)
        );
    }
}

#[test]
fn v2_headers_name_the_source_or_nothing() {
    let (fixed, body) = v2(0x1, 0x11, &v2_tcp4([203, 0, 113, 9], 51234));
    assert_eq!(
        parse_v2(&fixed, &body).unwrap(),
        Some("203.0.113.9:51234".parse().unwrap())
    );

    let mut tcp6 = Vec::new();
    tcp6.extend_from_slice(&"2001:db8::5".parse::<Ipv6Addr>().unwrap().octets());
    tcp6.extend_from_slice(&"2001:db8::1".parse::<Ipv6Addr>().unwrap().octets());
    tcp6.extend_from_slice(&40000_u16.to_be_bytes());
    tcp6.extend_from_slice(&2222_u16.to_be_bytes());
    // A TLV after the addresses is ignored.
    tcp6.extend_from_slice(&[0x04, 0x00, 0x01, 0xaa]);
    let (fixed, body) = v2(0x1, 0x21, &tcp6);
    assert_eq!(
        parse_v2(&fixed, &body).unwrap(),
        Some("[2001:db8::5]:40000".parse().unwrap())
    );

    // LOCAL (health check) and UNSPEC carry no client.
    let (fixed, body) = v2(0x0, 0x11, &v2_tcp4([203, 0, 113, 9], 1));
    assert_eq!(parse_v2(&fixed, &body).unwrap(), None);
    let (fixed, body) = v2(0x1, 0x00, &[]);
    assert_eq!(parse_v2(&fixed, &body).unwrap(), None);

    let (fixed, body) = v2(0x1, 0x11, &v2_tcp4([203, 0, 113, 9], 1)[..8]);
    assert!(parse_v2(&fixed, &body).is_err(), "truncated addresses");
    let (fixed, body) = v2(0x2, 0x11, &v2_tcp4([203, 0, 113, 9], 1));
    assert!(parse_v2(&fixed, &body).is_err(), "unknown command");
    let (mut fixed, body) = v2(0x1, 0x11, &v2_tcp4([203, 0, 113, 9], 1));
    fixed[12] = 0x11;
    assert!(
        parse_v2(&fixed, &body).is_err(),
        "version 1 in a binary header"
    );
    fixed[12] = 0x21;
    fixed[0] = b'X';
    assert!(parse_v2(&fixed, &body).is_err(), "bad signature");
}

async fn pair() -> (TcpStream, TcpStream, SocketAddr) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let client = TcpStream::connect(listener.local_addr().unwrap())
        .await
        .unwrap();
    let (server, peer) = listener.accept().await.unwrap();
    (client, server, peer)
}

#[tokio::test]
async fn reads_only_the_header_and_leaves_the_ssh_banner() {
    for header in [
        b"PROXY TCP4 203.0.113.9 10.8.16.31 51234 2222\r\n".to_vec(),
        {
            let (fixed, body) = v2(0x1, 0x11, &v2_tcp4([203, 0, 113, 9], 51234));
            [&fixed[..], &body].concat()
        },
    ] {
        let (mut client, mut server, peer) = pair().await;
        client.write_all(&header).await.unwrap();
        client.write_all(b"SSH-2.0-test\r\n").await.unwrap();
        let address = read_client_address(&mut server, peer, TEST_TIMEOUT)
            .await
            .unwrap();
        assert_eq!(address, "203.0.113.9:51234".parse().unwrap());
        let mut rest = [0_u8; 14];
        server.read_exact(&mut rest).await.unwrap();
        assert_eq!(&rest, b"SSH-2.0-test\r\n");
    }
}

#[tokio::test]
async fn a_trusted_peer_without_a_header_is_its_own_client() {
    let (mut client, mut server, peer) = pair().await;
    client.write_all(b"SSH-2.0-test\r\n").await.unwrap();
    assert_eq!(
        read_client_address(&mut server, peer, TEST_TIMEOUT)
            .await
            .unwrap(),
        peer
    );
    let mut rest = [0_u8; 14];
    server.read_exact(&mut rest).await.unwrap();
    assert_eq!(&rest, b"SSH-2.0-test\r\n");

    let (client, mut server, peer) = pair().await;
    drop(client);
    assert_eq!(
        read_client_address(&mut server, peer, TEST_TIMEOUT)
            .await
            .unwrap(),
        peer
    );
}

#[tokio::test]
async fn silent_and_stalled_headers_are_bounded() {
    // Silent: the client is waiting for the server banner.
    let (_client, mut server, peer) = pair().await;
    assert_eq!(
        read_client_address(&mut server, peer, TEST_TIMEOUT)
            .await
            .unwrap(),
        peer
    );

    let (mut client, mut server, peer) = pair().await;
    client.write_all(b"PROXY TCP4 203.0.113.9").await.unwrap();
    let error = read_client_address(&mut server, peer, TEST_TIMEOUT)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("timeout"), "{error}");
}

#[tokio::test]
async fn overlong_v1_lines_are_rejected() {
    let (mut client, mut server, peer) = pair().await;
    client.write_all(&[b'P'; 200]).await.unwrap();
    assert!(read_client_address(&mut server, peer, TEST_TIMEOUT)
        .await
        .is_err());
}
