use super::*;
use std::time::Duration;

/// Decodes `wire` (split as `initial` + the rest from the socket) and
/// returns what the upstream received.
async fn decode(initial: &[u8], rest: &[u8], max_body: usize) -> (Result<()>, Vec<u8>) {
    let (mut client, mut inbound) = tokio::io::duplex(64);
    let rest = rest.to_vec();
    let writer = tokio::spawn(async move {
        // Trickle in small pieces so framing straddles reads.
        for piece in rest.chunks(3) {
            if client.write_all(piece).await.is_err() {
                return;
            }
            tokio::task::yield_now().await;
        }
        let _ = client.shutdown().await;
    });
    let mut upstream = Vec::new();
    let result = tokio::time::timeout(
        Duration::from_secs(2),
        forward_chunked_body(&mut inbound, &mut upstream, initial, max_body),
    )
    .await
    .expect("decoder hung");
    writer.abort();
    (result, upstream)
}

#[tokio::test]
async fn valid_bodies_are_rechunked_without_extensions_or_trailers() {
    let wire = b"4\r\nWiki\r\n5;name=\"v\"\r\npedia\r\nE \t;x\r\n in\r\n\r\nchunks.\r\n0\r\nX-Checksum: abc\r\n\r\n";
    for split in [0, 1, 7, 20, wire.len()] {
        let (result, upstream) = decode(&wire[..split], &wire[split..], 1024).await;
        result.unwrap();
        assert_eq!(
            String::from_utf8(upstream).unwrap(),
            "4\r\nWiki\r\n5\r\npedia\r\ne\r\n in\r\n\r\nchunks.\r\n0\r\n\r\n"
        );
    }
    let (result, upstream) = decode(b"0\r\n\r\n", b"", 0).await;
    result.unwrap();
    assert_eq!(upstream, b"0\r\n\r\n");
}

#[tokio::test]
async fn malformed_or_smuggling_framing_is_rejected_without_a_final_chunk() {
    let cases: &[&[u8]] = &[
        b"4\nWiki\r\n0\r\n\r\n",
        b"4\r\nWiki\n0\r\n\r\n",
        b"4\rx\r\nWiki\r\n0\r\n\r\n",
        b" 4\r\nWiki\r\n0\r\n\r\n",
        b"4 \r\nWiki\r\n0\r\n\r\n",
        b"+4\r\nWiki\r\n0\r\n\r\n",
        b"-1\r\nWiki\r\n0\r\n\r\n",
        b"0x4\r\nWiki\r\n0\r\n\r\n",
        b"\r\nWiki\r\n0\r\n\r\n",
        b"4;\x01\r\nWiki\r\n0\r\n\r\n",
        b"4\r\nWikiXX\r\n0\r\n\r\n",
        b"4\r\nWiki0\r\n\r\n",
        b"11111111111111111\r\n",
        b"ffffffffffffffff\r\nWiki\r\n0\r\n\r\n",
        b"5\r\nhello\r\n5\r\nworld\r\n0\r\n\r\n",
        b"0\r\nX-A: 1\r\n continued\r\n\r\n",
        b"0\r\nno-colon\r\n\r\n",
        b"0\r\nBad Name: 1\r\n\r\n",
        b"0\r\n\r\nGET /admin HTTP/1.1\r\nHost: other.example.test\r\n\r\n",
        b"4\r\nWi",
        b"4\r\nWiki\r\n",
    ];
    for wire in cases {
        let (result, upstream) = decode(wire, b"", 8).await;
        assert!(
            result.is_err(),
            "accepted {:?}",
            String::from_utf8_lossy(wire)
        );
        assert!(
            !upstream.ends_with(b"0\r\n\r\n"),
            "{:?} reached the upstream as a complete body",
            String::from_utf8_lossy(wire)
        );
        // Same input arriving over the socket rather than with the head.
        let (result, _) = decode(b"", wire, 8).await;
        assert!(result.is_err());
    }
}

#[tokio::test]
async fn oversized_lines_and_trailers_are_bounded() {
    let mut long_extension = b"1;".to_vec();
    long_extension.resize(MAX_CHUNK_LINE_BYTES + 10, b'a');
    long_extension.extend_from_slice(b"\r\nx\r\n0\r\n\r\n");
    let (result, _) = decode(b"", &long_extension, 1024).await;
    assert!(result.unwrap_err().to_string().contains("too long"));

    let mut trailers = b"0\r\n".to_vec();
    for index in 0..1000 {
        trailers.extend_from_slice(format!("X-T{index}: value\r\n").as_bytes());
    }
    trailers.extend_from_slice(b"\r\n");
    let (result, _) = decode(b"", &trailers, 1024).await;
    assert!(result.unwrap_err().to_string().contains("trailer"));
}

#[test]
fn chunk_sizes_are_plain_bounded_hex() {
    assert_eq!(parse_chunk_size(b"0").unwrap(), 0);
    assert_eq!(parse_chunk_size(b"fF").unwrap(), 255);
    assert_eq!(parse_chunk_size(b"10 ; a=b").unwrap(), 16);
    assert_eq!(parse_chunk_size(b"ffffffffffffffff").unwrap(), u64::MAX);
    for invalid in [
        b"".as_slice(),
        b"g",
        b"1 ",
        b"1 x",
        b"1\t",
        b"0x1",
        b"10000000000000000",
    ] {
        assert!(parse_chunk_size(invalid).is_err(), "{invalid:?}");
    }
}
