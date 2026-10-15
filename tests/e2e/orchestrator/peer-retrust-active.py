#!/usr/bin/env python3
"""Re-admit the active Incus client certificate onto the GPU peer.

Certificate rotation requires every registered server to verify the staged
candidate. If the peer still trusts an older client identity but not the
current active one, rotation hangs until Playwright times out.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import ssl
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def b64url_decode(value: str) -> bytes:
    pad = '=' * ((4 - len(value) % 4) % 4)
    return base64.urlsafe_b64decode(value + pad)


def decrypt_private_key(ciphertext: str, secret: str) -> bytes:
    parts = ciphertext.split('.')
    if len(parts) != 4 or parts[0] != 'incus-v1':
        raise SystemExit('invalid encrypted private key')
    iv, tag, encrypted = map(b64url_decode, parts[1:])
    key = hashlib.sha256(secret.encode('utf-8')).digest()
    return AESGCM(key).decrypt(iv, encrypted + tag, None)


def psql_json(database_url: str, sql: str) -> Any:
    result = subprocess.run(
        ['psql', database_url, '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql],
        check=True,
        capture_output=True,
        text=True,
    )
    text = result.stdout.strip()
    if not text or text == '':
        return None
    return json.loads(text)


def fetch_state(database_url: str, peer_server_id: str) -> tuple[dict[str, Any], list[dict[str, Any]], str]:
    active = psql_json(
        database_url,
        """
        SELECT row_to_json(x) FROM (
          SELECT id, generation, fingerprint, certificate_pem, encrypted_private_key
          FROM system.incus_client_certificates
          WHERE state = 'active'
        ) x;
        """,
    )
    if not active:
        raise SystemExit('active certificate missing')
    peer = psql_json(
        database_url,
        f"""
        SELECT row_to_json(x) FROM (
          SELECT id, api_endpoint
          FROM infra.servers
          WHERE id = '{peer_server_id}'
        ) x;
        """,
    )
    if not peer or not peer.get('api_endpoint'):
        raise SystemExit('peer server missing')
    trusted = psql_json(
        database_url,
        f"""
        SELECT COALESCE(json_agg(row_to_json(x) ORDER BY generation ASC), '[]'::json) FROM (
          SELECT c.generation, c.fingerprint, c.certificate_pem, c.encrypted_private_key
          FROM system.incus_client_certificates c
          JOIN system.incus_client_certificate_trusts t ON t.certificate_id = c.id
          WHERE t.server_id = '{peer_server_id}' AND t.state = 'verified'
        ) x;
        """,
    ) or []
    return active, trusted, str(peer['api_endpoint']).rstrip('/')


def mark_verified(database_url: str, certificate_id: str, peer_server_id: str) -> None:
    subprocess.run(
        [
            'psql', database_url, '-v', 'ON_ERROR_STOP=1', '-c',
            f"""
            INSERT INTO system.incus_client_certificate_trusts
              (certificate_id, server_id, state, last_error, observed_at)
            VALUES ('{certificate_id}', '{peer_server_id}', 'verified', NULL, clock_timestamp())
            ON CONFLICT (certificate_id, server_id) DO UPDATE
            SET state = 'verified', last_error = NULL, observed_at = clock_timestamp();
            """,
        ],
        check=True,
        capture_output=True,
        text=True,
    )


def tls_context(cert_pem: str, key_pem: bytes) -> ssl.SSLContext:
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    with tempfile.TemporaryDirectory() as tmp:
        cert_path = os.path.join(tmp, 'client.crt')
        key_path = os.path.join(tmp, 'client.key')
        with open(cert_path, 'w', encoding='utf-8') as handle:
            handle.write(cert_pem)
        with open(key_path, 'wb') as handle:
            handle.write(key_pem)
        ctx.load_cert_chain(certfile=cert_path, keyfile=key_path)
        # load_cert_chain copies material into the context; temp files can go away.
        return ctx


def probe(peer_url: str, cert_pem: str, key_pem: bytes) -> str | None:
    try:
        with tempfile.TemporaryDirectory() as tmp:
            cert_path = os.path.join(tmp, 'client.crt')
            key_path = os.path.join(tmp, 'client.key')
            with open(cert_path, 'w', encoding='utf-8') as handle:
                handle.write(cert_pem)
            with open(key_path, 'wb') as handle:
                handle.write(key_pem)
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            ctx.load_cert_chain(certfile=cert_path, keyfile=key_path)
            with urllib.request.urlopen(peer_url + '/1.0', context=ctx, timeout=8) as response:
                body = json.loads(response.read().decode())
                return body.get('metadata', {}).get('auth')
    except Exception as error:  # noqa: BLE001
        print(f'probe error: {error}', file=sys.stderr)
        return None


def add_certificate(peer_url: str, auth_cert: str, auth_key: bytes, candidate_pem: str, name: str) -> int:
    bare = ''.join(
        line for line in candidate_pem.splitlines()
        if line and not line.startswith('-----')
    )
    payload = json.dumps({'type': 'client', 'name': name, 'certificate': bare}).encode()
    with tempfile.TemporaryDirectory() as tmp:
        cert_path = os.path.join(tmp, 'client.crt')
        key_path = os.path.join(tmp, 'client.key')
        with open(cert_path, 'w', encoding='utf-8') as handle:
            handle.write(auth_cert)
        with open(key_path, 'wb') as handle:
            handle.write(auth_key)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        ctx.load_cert_chain(certfile=cert_path, keyfile=key_path)
        request = urllib.request.Request(
            peer_url + '/1.0/certificates',
            data=payload,
            method='POST',
            headers={'Content-Type': 'application/json'},
        )
        try:
            with urllib.request.urlopen(request, context=ctx, timeout=15) as response:
                return response.status
        except urllib.error.HTTPError as error:
            body = error.read().decode()
            if error.code in (400, 409) and 'already' in body.lower():
                return 200
            print(f'add certificate failed: {error.code} {body[:300]}', file=sys.stderr)
            return error.code


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--database-url', required=True)
    parser.add_argument('--secret', required=True)
    parser.add_argument('--peer-server-id', required=True)
    args = parser.parse_args()

    active, trusted_history, peer_url = fetch_state(args.database_url, args.peer_server_id)
    active_key = decrypt_private_key(active['encrypted_private_key'], args.secret)
    auth = probe(peer_url, active['certificate_pem'], active_key)
    print(f"active gen={active['generation']} auth={auth} peer={peer_url}")
    if auth == 'trusted':
        mark_verified(args.database_url, active['id'], args.peer_server_id)
        print('peer already trusts active certificate')
        return 0

    for row in trusted_history:
        key = decrypt_private_key(row['encrypted_private_key'], args.secret)
        if probe(peer_url, row['certificate_pem'], key) != 'trusted':
            continue
        print(f"using historical gen={row['generation']} to admit active")
        status = add_certificate(
            peer_url,
            row['certificate_pem'],
            key,
            active['certificate_pem'],
            f"nyabase-e2e-active-gen{active['generation']}",
        )
        if status not in (200, 201):
            continue
        auth = probe(peer_url, active['certificate_pem'], active_key)
        print(f'active auth after admit={auth}')
        if auth == 'trusted':
            mark_verified(args.database_url, active['id'], args.peer_server_id)
            return 0

    print('unable to admit active certificate onto peer', file=sys.stderr)
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
