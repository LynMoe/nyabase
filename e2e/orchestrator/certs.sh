#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
run_id="$(require_run_id "${1:-}")"
load_run "$run_id"

cert_dir="$NYABASE_E2E_RUNTIME_DIR/certs"
install -d -m 0700 "$cert_dir"
if [[ -s "$cert_dir/ca.crt" ]]; then
  log "certificates already exist for $run_id"
  exit 0
fi

umask 077
openssl genrsa -out "$cert_dir/ca.key" 3072 >/dev/null 2>&1
openssl req -x509 -new -sha256 -days 2 \
  -key "$cert_dir/ca.key" -out "$cert_dir/ca.crt" \
  -subj "/CN=nyabase-e2e-${run_id}-ca" >/dev/null 2>&1

issue_cert() {
  local name="$1" san="$2"
  openssl genrsa -out "$cert_dir/${name}.key" 2048 >/dev/null 2>&1
  openssl req -new -key "$cert_dir/${name}.key" \
    -out "$cert_dir/${name}.csr" -subj "/CN=${name}" >/dev/null 2>&1
  printf '%s\n' \
    'basicConstraints=CA:FALSE' \
    'keyUsage=digitalSignature,keyEncipherment' \
    'extendedKeyUsage=serverAuth' \
    "subjectAltName=${san}" > "$cert_dir/${name}.ext"
  openssl x509 -req -sha256 -days 2 \
    -in "$cert_dir/${name}.csr" \
    -CA "$cert_dir/ca.crt" -CAkey "$cert_dir/ca.key" -CAcreateserial \
    -extfile "$cert_dir/${name}.ext" -out "$cert_dir/${name}.crt" >/dev/null 2>&1
  rm -f "$cert_dir/${name}.csr" "$cert_dir/${name}.ext"
}

issue_cert edge "DNS:localhost,DNS:edge,IP:127.0.0.1,IP:${NYABASE_E2E_EDGE_IP}"
issue_cert registry "DNS:registry,IP:${NYABASE_E2E_REGISTRY_IP}"
chmod 0600 "$cert_dir"/*.key
chmod 0644 "$cert_dir"/*.crt
openssl verify -CAfile "$cert_dir/ca.crt" "$cert_dir/edge.crt" "$cert_dir/registry.crt" >/dev/null
openssl x509 -in "$cert_dir/edge.crt" -pubkey -noout \
  | openssl pkey -pubin -outform DER \
  | openssl dgst -sha256 -binary \
  | openssl base64 -A > "$cert_dir/edge.spki"
printf '\n' >> "$cert_dir/edge.spki"
chmod 0644 "$cert_dir/edge.spki"
manifest_phase certs
log "generated per-run CA and TLS certificates for $run_id"
