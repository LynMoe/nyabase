#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
run_id="$(require_run_id "${1:-}")"
load_run "$run_id"

[[ "$NYABASE_E2E_PROFILE" == full || "$NYABASE_E2E_PROFILE" == recovery ]] \
  || die 'Rust proxy fixtures require a proxy-enabled profile'
for image in "$NYABASE_E2E_SSH_PROXY_IMAGE" "$NYABASE_E2E_HTTP_PROXY_IMAGE"; do
  docker image inspect "$image" >/dev/null 2>&1 || die "Full proxy image is missing: $image"
done
# shellcheck disable=SC1090
source "$NYABASE_E2E_RUNTIME_DIR/secrets.env"

proxy_dir="$NYABASE_E2E_RUNTIME_DIR/proxies"
ssh_name="$NYABASE_E2E_PREFIX-ssh-proxy"
http_name="$NYABASE_E2E_PREFIX-http-proxy"
[[ ! -e "$proxy_dir" ]] || die 'Full proxy private runtime already exists for this run'
install -d -m 0700 "$proxy_dir"
install -m 0600 /dev/null "$proxy_dir/ssh-token"
install -m 0600 /dev/null "$proxy_dir/http-token"
printf '%s' "$SSH_PROXY_TOKEN" > "$proxy_dir/ssh-token"
printf '%s' "$HTTP_PROXY_TOKEN" > "$proxy_dir/http-token"
chown 65532:65532 "$proxy_dir/ssh-token" "$proxy_dir/http-token"

ssh-keygen -q -t ed25519 -N '' -C "nyabase-e2e-external-$run_id" \
  -f "$proxy_dir/external-key"
chmod 0600 "$proxy_dir/external-key"
chmod 0644 "$proxy_dir/external-key.pub"
install -m 0600 /dev/null "$proxy_dir/client.json"
node --input-type=module - \
  "$proxy_dir/client.json" "$run_id" "$proxy_dir/external-key.pub" <<'NODE'
import { writeFileSync } from 'node:fs';
const [path, runId, publicKeyFile] = process.argv.slice(2);
writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, runId, publicKeyFile }, null, 2)}\n`, {
  mode: 0o600,
});
NODE

docker run -d \
  --name "$ssh_name" --hostname "$ssh_name" \
  --label "io.nyabase.e2e.run-id=$run_id" \
  --label 'io.nyabase.e2e.managed=true' \
  --label 'io.nyabase.e2e.component=ssh-proxy' \
  --network "$NYABASE_E2E_NETWORK" --ip "$NYABASE_E2E_SSH_PROXY_IP" \
  --user 65532:65532 --read-only --cap-drop ALL \
  --security-opt no-new-privileges=true --pids-limit 128 --memory 256m --cpus 1 \
  --mount "type=bind,src=$proxy_dir/ssh-token,dst=/run/secrets/proxy-token,readonly" \
  --mount "type=bind,src=$NYABASE_E2E_RUNTIME_DIR/certs/ca.crt,dst=/run/ca/backend-ca.crt,readonly" \
  --env 'NYABASE_BACKEND_WS=wss://edge/ws/ssh-proxy' \
  --env 'NYABASE_BACKEND_CA_FILE=/run/ca/backend-ca.crt' \
  --env 'SSH_PROXY_TOKEN_FILE=/run/secrets/proxy-token' \
  --env 'NYABASE_SSH_LISTEN=0.0.0.0:2222' \
  --env 'NYABASE_SSH_STATUS_INTERVAL_MS=250' \
  --env 'RUST_LOG=info' \
  "$NYABASE_E2E_SSH_PROXY_IMAGE" >/dev/null
manifest_resource container "$ssh_name"

docker run -d \
  --name "$http_name" --hostname "$http_name" \
  --label "io.nyabase.e2e.run-id=$run_id" \
  --label 'io.nyabase.e2e.managed=true' \
  --label 'io.nyabase.e2e.component=http-proxy' \
  --network "$NYABASE_E2E_NETWORK" --ip "$NYABASE_E2E_HTTP_PROXY_IP" \
  --user 65532:65532 --read-only --cap-drop ALL \
  --security-opt no-new-privileges=true --pids-limit 128 --memory 256m --cpus 1 \
  --mount "type=bind,src=$proxy_dir/http-token,dst=/run/secrets/proxy-token,readonly" \
  --mount "type=bind,src=$NYABASE_E2E_RUNTIME_DIR/certs/ca.crt,dst=/run/ca/backend-ca.crt,readonly" \
  --env 'NYABASE_BACKEND_WS=wss://edge/ws/http-proxy' \
  --env 'NYABASE_BACKEND_CA_FILE=/run/ca/backend-ca.crt' \
  --env 'HTTP_PROXY_TOKEN_FILE=/run/secrets/proxy-token' \
  --env 'NYABASE_HTTP_LISTEN=0.0.0.0:8080' \
  --env 'NYABASE_HTTP_STATUS_INTERVAL_MS=250' \
  --env 'RUST_LOG=info' \
  "$NYABASE_E2E_HTTP_PROXY_IMAGE" >/dev/null
manifest_resource container "$http_name"

NODE_EXTRA_CA_CERTS="$NYABASE_E2E_RUNTIME_DIR/certs/ca.crt" \
  node "$E2E_ROOT/e2e/orchestrator/proxy-health.mjs" "$NYABASE_E2E_RUNTIME_DIR" 120000
log 'proxy fixtures PASS: current Rust SSH and HTTP processes acknowledged real Backend snapshots'
