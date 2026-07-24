#!/usr/bin/env bash

set -euo pipefail
umask 077

POC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$POC_DIR/lib.sh"
poc_init

for command in docker openssl ssh-keygen sha256sum node curl; do require_command "$command"; done
docker info >/dev/null

CARGO_BIN="${NYABASE_FULL_PROXY_POC_CARGO:-$(command -v cargo 2>/dev/null || true)}"
if [[ -z "$CARGO_BIN" && -x /root/.cargo/bin/cargo ]]; then
  CARGO_BIN=/root/.cargo/bin/cargo
fi
if [[ -z "$CARGO_BIN" || ! -x "$CARGO_BIN" ]]; then
  echo 'Rust cargo is required; set NYABASE_FULL_PROXY_POC_CARGO to its absolute path' >&2
  exit 1
fi

mkdir -p "$PRIVATE_DIR" "$PRIVATE_DIR/proxy-ssh-image" "$PRIVATE_DIR/proxy-http-image" "$PRIVATE_DIR/snapshots"
: >"$STATE_FILE"
state_put RUN_ID "$RUN_ID"
state_put ARTIFACT_DIR "$ARTIFACT_DIR"
state_put PRIVATE_DIR "$PRIVATE_DIR"
state_put STATE_FILE "$STATE_FILE"
state_put LOG_DIR "$LOG_DIR"

cleanup_on_error() {
  local status=$?
  if (( status != 0 )); then
    collect_logs || true
    NYABASE_FULL_PROXY_POC_RUN_ID="$RUN_ID" \
      NYABASE_FULL_PROXY_POC_ARTIFACT_DIR="$ARTIFACT_DIR" \
      bash "$POC_DIR/down.sh" || true
  fi
  exit "$status"
}
trap cleanup_on_error EXIT

(
  cd "$REPO_ROOT"
  "$CARGO_BIN" build --manifest-path tools/ssh-proxy/Cargo.toml --release --locked
) &
ssh_build_pid=$!
(
  cd "$REPO_ROOT"
  "$CARGO_BIN" build --manifest-path tools/http-proxy/Cargo.toml --release --locked
) &
http_build_pid=$!
wait "$ssh_build_pid"
wait "$http_build_pid"

SSH_BINARY="$REPO_ROOT/tools/ssh-proxy/target/release/nyabase-ssh-proxy"
HTTP_BINARY="$REPO_ROOT/tools/http-proxy/target/release/nyabase-http-proxy"
SSH_BINARY_HASH="$(sha256sum "$SSH_BINARY" | awk '{print $1}')"
HTTP_BINARY_HASH="$(sha256sum "$HTTP_BINARY" | awk '{print $1}')"
SOURCE_GIT_HEAD="$(git -C "$REPO_ROOT" rev-parse HEAD)"
SSH_TREE_HASH="$(find "$REPO_ROOT/tools/ssh-proxy" -path '*/target' -prune -o -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')"
HTTP_TREE_HASH="$(find "$REPO_ROOT/tools/http-proxy" -path '*/target' -prune -o -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')"

install -m 0755 "$SSH_BINARY" "$PRIVATE_DIR/proxy-ssh-image/proxy"
install -m 0644 "$POC_DIR/Dockerfile.proxy" "$PRIVATE_DIR/proxy-ssh-image/Dockerfile"
install -m 0755 "$HTTP_BINARY" "$PRIVATE_DIR/proxy-http-image/proxy"
install -m 0644 "$POC_DIR/Dockerfile.proxy" "$PRIVATE_DIR/proxy-http-image/Dockerfile"

safe_tag="$(printf '%s' "$RUN_ID" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_.-' '-')"
SSH_IMAGE="nyabase-full-proxy-poc-ssh:${safe_tag}"
HTTP_IMAGE="nyabase-full-proxy-poc-http:${safe_tag}"
CONTROL_IMAGE="nyabase-full-proxy-poc-control:${safe_tag}"
HTTP_TARGET_IMAGE="nyabase-full-proxy-poc-http-target:${safe_tag}"
SSH_TARGET_IMAGE="nyabase-full-proxy-poc-ssh-target:${safe_tag}"
build_labels=(--label "${POC_LABEL_KEY}=full-proxies" --label "${RUN_LABEL_KEY}=${RUN_ID}")

docker build "${build_labels[@]}" -t "$SSH_IMAGE" "$PRIVATE_DIR/proxy-ssh-image"
docker build "${build_labels[@]}" -t "$HTTP_IMAGE" "$PRIVATE_DIR/proxy-http-image"
docker build "${build_labels[@]}" -f "$POC_DIR/Dockerfile.control" -t "$CONTROL_IMAGE" "$POC_DIR"
docker build "${build_labels[@]}" -f "$POC_DIR/Dockerfile.http-workload" -t "$HTTP_TARGET_IMAGE" "$POC_DIR"
docker build "${build_labels[@]}" -f "$POC_DIR/Dockerfile.ssh-target" -t "$SSH_TARGET_IMAGE" "$POC_DIR"

SSH_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$SSH_IMAGE")"
HTTP_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$HTTP_IMAGE")"

printf '%s' "$(openssl rand -hex 32)" >"$PRIVATE_DIR/ssh-token"
printf '%s' "$(openssl rand -hex 32)" >"$PRIVATE_DIR/http-token"
printf '%s' "$(openssl rand -hex 32)" >"$PRIVATE_DIR/admin-token"
chmod 0600 "$PRIVATE_DIR/ssh-token" "$PRIVATE_DIR/http-token" "$PRIVATE_DIR/admin-token"
chown 65532:65532 "$PRIVATE_DIR/ssh-token" "$PRIVATE_DIR/http-token" "$PRIVATE_DIR/admin-token"

openssl req -x509 -newkey rsa:2048 -nodes -days 1 -sha256 \
  -subj "/CN=nyabase-full-proxy-poc-ca-${RUN_ID}" \
  -keyout "$PRIVATE_DIR/ca.key" -out "$PRIVATE_DIR/ca.crt" >/dev/null 2>&1
openssl req -new -newkey rsa:2048 -nodes -sha256 -subj '/CN=control' \
  -keyout "$PRIVATE_DIR/control.key" -out "$PRIVATE_DIR/control.csr" >/dev/null 2>&1
openssl x509 -req -days 1 -sha256 -in "$PRIVATE_DIR/control.csr" \
  -CA "$PRIVATE_DIR/ca.crt" -CAkey "$PRIVATE_DIR/ca.key" -CAcreateserial \
  -extfile "$POC_DIR/control-cert.ext" -out "$PRIVATE_DIR/control.crt" >/dev/null 2>&1
chmod 0600 "$PRIVATE_DIR/ca.key" "$PRIVATE_DIR/control.key" "$PRIVATE_DIR/control.crt" "$PRIVATE_DIR/ca.crt"
chown 65532:65532 "$PRIVATE_DIR/control.key" "$PRIVATE_DIR/control.crt" "$PRIVATE_DIR/ca.crt"

ssh-keygen -q -t ed25519 -N '' -C "external-${RUN_ID}" -f "$PRIVATE_DIR/external-key"
ssh-keygen -q -t ed25519 -N '' -C "internal-${RUN_ID}" -f "$PRIVATE_DIR/internal-key"
ssh-keygen -q -t ed25519 -N '' -C "proxy-host-${RUN_ID}" -f "$PRIVATE_DIR/proxy-host-key"
ssh-keygen -q -t ed25519 -N '' -C "target-host-${RUN_ID}" -f "$PRIVATE_DIR/target-host-key"
cp "$PRIVATE_DIR/internal-key.pub" "$PRIVATE_DIR/authorized_keys"
chmod 0600 "$PRIVATE_DIR/authorized_keys" "$PRIVATE_DIR/target-host-key"

NETWORK_NAME="nyabase-full-proxy-poc-${safe_tag}"
docker network create \
  --label "${POC_LABEL_KEY}=full-proxies" \
  --label "${RUN_LABEL_KEY}=${RUN_ID}" \
  "$NETWORK_NAME" >/dev/null

container_labels=(--label "${POC_LABEL_KEY}=full-proxies" --label "${RUN_LABEL_KEY}=${RUN_ID}")
SSH_TARGET_NAME="${NETWORK_NAME}-ssh-target"
HTTP_TARGET_NAME="${NETWORK_NAME}-http-target"
CONTROL_NAME="${NETWORK_NAME}-control"
SSH_PROXY_NAME="${NETWORK_NAME}-ssh-proxy"
HTTP_PROXY_NAME="${NETWORK_NAME}-http-proxy"

docker run -d --name "$SSH_TARGET_NAME" "${container_labels[@]}" \
  --network "$NETWORK_NAME" --read-only --tmpfs /run/sshd:rw,nosuid,nodev,noexec,size=1m \
  --tmpfs /tmp:rw,nosuid,nodev,size=32m \
  --mount "type=bind,src=$PRIVATE_DIR/target-host-key,dst=/fixture/ssh_host_ed25519_key,readonly" \
  --mount "type=bind,src=$PRIVATE_DIR/authorized_keys,dst=/fixture/authorized_keys,readonly" \
  "$SSH_TARGET_IMAGE" >/dev/null

docker run -d --name "$HTTP_TARGET_NAME" "${container_labels[@]}" \
  --network "$NETWORK_NAME" --user 65532:65532 --read-only --cap-drop ALL \
  --security-opt no-new-privileges=true --pids-limit 64 --memory 128m --cpus 0.50 \
  "$HTTP_TARGET_IMAGE" >/dev/null

SSH_TARGET_IP="$(docker inspect --format "{{with index .NetworkSettings.Networks \"$NETWORK_NAME\"}}{{.IPAddress}}{{end}}" "$SSH_TARGET_NAME")"
HTTP_TARGET_IP="$(docker inspect --format "{{with index .NetworkSettings.Networks \"$NETWORK_NAME\"}}{{.IPAddress}}{{end}}" "$HTTP_TARGET_NAME")"
INTERNAL_KEY_FINGERPRINT="$(ssh-keygen -lf "$PRIVATE_DIR/internal-key.pub" -E sha256 | awk '{print $2}')"
PROXY_HOST_KEY_FINGERPRINT="$(ssh-keygen -lf "$PRIVATE_DIR/proxy-host-key.pub" -E sha256 | awk '{print $2}')"
TARGET_HOST_KEY_FINGERPRINT="$(ssh-keygen -lf "$PRIVATE_DIR/target-host-key.pub" -E sha256 | awk '{print $2}')"

SNAPSHOT_DIR="$PRIVATE_DIR/snapshots" \
EXTERNAL_PUBLIC_KEY_FILE="$PRIVATE_DIR/external-key.pub" \
INTERNAL_PRIVATE_KEY_FILE="$PRIVATE_DIR/internal-key" \
INTERNAL_PUBLIC_KEY_FILE="$PRIVATE_DIR/internal-key.pub" \
PROXY_HOST_PRIVATE_KEY_FILE="$PRIVATE_DIR/proxy-host-key" \
PROXY_HOST_PUBLIC_KEY_FILE="$PRIVATE_DIR/proxy-host-key.pub" \
INTERNAL_KEY_FINGERPRINT="$INTERNAL_KEY_FINGERPRINT" \
PROXY_HOST_KEY_FINGERPRINT="$PROXY_HOST_KEY_FINGERPRINT" \
TARGET_HOST_KEY_FINGERPRINT="$TARGET_HOST_KEY_FINGERPRINT" \
SSH_TARGET_IP="$SSH_TARGET_IP" HTTP_TARGET_IP="$HTTP_TARGET_IP" \
node "$POC_DIR/generate-snapshots.mjs"
chown -R 65532:65532 "$PRIVATE_DIR/snapshots"
chmod 0600 "$PRIVATE_DIR/snapshots"/*.json

docker run -d --name "$CONTROL_NAME" "${container_labels[@]}" \
  --network "$NETWORK_NAME" --network-alias control -p '127.0.0.1::8443' \
  --user 65532:65532 --read-only --cap-drop ALL --security-opt no-new-privileges=true \
  --pids-limit 64 --memory 192m --cpus 0.75 \
  --mount "type=bind,src=$PRIVATE_DIR/control.key,dst=/run/secrets/control.key,readonly" \
  --mount "type=bind,src=$PRIVATE_DIR/control.crt,dst=/run/secrets/control.crt,readonly" \
  --mount "type=bind,src=$PRIVATE_DIR/admin-token,dst=/run/secrets/admin-token,readonly" \
  --mount "type=bind,src=$PRIVATE_DIR/ssh-token,dst=/run/secrets/ssh-token,readonly" \
  --mount "type=bind,src=$PRIVATE_DIR/http-token,dst=/run/secrets/http-token,readonly" \
  --mount "type=bind,src=$PRIVATE_DIR/snapshots,dst=/run/snapshots,readonly" \
  -e CONTROL_TLS_KEY_FILE=/run/secrets/control.key \
  -e CONTROL_TLS_CERT_FILE=/run/secrets/control.crt \
  -e CONTROL_ADMIN_TOKEN_FILE=/run/secrets/admin-token \
  -e SSH_PROXY_TOKEN_FILE=/run/secrets/ssh-token \
  -e HTTP_PROXY_TOKEN_FILE=/run/secrets/http-token \
  -e SSH_INITIAL_SNAPSHOT_FILE=/run/snapshots/ssh-initial.json \
  -e SSH_REVOKED_SNAPSHOT_FILE=/run/snapshots/ssh-revoked.json \
  -e HTTP_INITIAL_SNAPSHOT_FILE=/run/snapshots/http-initial.json \
  -e HTTP_REVOKED_SNAPSHOT_FILE=/run/snapshots/http-revoked.json \
  "$CONTROL_IMAGE" >/dev/null

CONTROL_PORT="$(docker port "$CONTROL_NAME" 8443/tcp | awk -F: 'NR==1 {print $NF}')"

docker run -d --name "$SSH_PROXY_NAME" "${container_labels[@]}" \
  --network "$NETWORK_NAME" -p '127.0.0.1::2222' \
  --user 65532:65532 --read-only --cap-drop ALL --security-opt no-new-privileges=true \
  --pids-limit 128 --memory 256m --cpus 1.00 \
  --mount "type=bind,src=$PRIVATE_DIR/ssh-token,dst=/run/secrets/proxy-token,readonly" \
  --mount "type=bind,src=$PRIVATE_DIR/ca.crt,dst=/run/ca/backend-ca.crt,readonly" \
  -e NYABASE_BACKEND_WS=wss://control:8443/ws/ssh-proxy \
  -e NYABASE_BACKEND_CA_FILE=/run/ca/backend-ca.crt \
  -e SSH_PROXY_TOKEN_FILE=/run/secrets/proxy-token \
  -e NYABASE_SSH_LISTEN=0.0.0.0:2222 \
  -e NYABASE_SSH_STATUS_INTERVAL_MS=250 \
  -e RUST_LOG=info \
  "$SSH_IMAGE" >/dev/null

docker run -d --name "$HTTP_PROXY_NAME" "${container_labels[@]}" \
  --network "$NETWORK_NAME" -p '127.0.0.1::8080' \
  --user 65532:65532 --read-only --cap-drop ALL --security-opt no-new-privileges=true \
  --pids-limit 128 --memory 256m --cpus 1.00 \
  --mount "type=bind,src=$PRIVATE_DIR/http-token,dst=/run/secrets/proxy-token,readonly" \
  --mount "type=bind,src=$PRIVATE_DIR/ca.crt,dst=/run/ca/backend-ca.crt,readonly" \
  -e NYABASE_BACKEND_WS=wss://control:8443/ws/http-proxy \
  -e NYABASE_BACKEND_CA_FILE=/run/ca/backend-ca.crt \
  -e HTTP_PROXY_TOKEN_FILE=/run/secrets/proxy-token \
  -e NYABASE_HTTP_LISTEN=0.0.0.0:8080 \
  -e NYABASE_HTTP_STATUS_INTERVAL_MS=250 \
  -e RUST_LOG=info \
  "$HTTP_IMAGE" >/dev/null

SSH_PORT="$(docker port "$SSH_PROXY_NAME" 2222/tcp | awk -F: 'NR==1 {print $NF}')"
HTTP_PORT="$(docker port "$HTTP_PROXY_NAME" 8080/tcp | awk -F: 'NR==1 {print $NF}')"

state_put SOURCE_GIT_HEAD "$SOURCE_GIT_HEAD"
state_put SSH_TREE_HASH "$SSH_TREE_HASH"
state_put HTTP_TREE_HASH "$HTTP_TREE_HASH"
state_put SSH_BINARY "$SSH_BINARY"
state_put HTTP_BINARY "$HTTP_BINARY"
state_put SSH_BINARY_HASH "$SSH_BINARY_HASH"
state_put HTTP_BINARY_HASH "$HTTP_BINARY_HASH"
state_put SSH_IMAGE "$SSH_IMAGE"
state_put HTTP_IMAGE "$HTTP_IMAGE"
state_put CONTROL_IMAGE "$CONTROL_IMAGE"
state_put HTTP_TARGET_IMAGE "$HTTP_TARGET_IMAGE"
state_put SSH_TARGET_IMAGE "$SSH_TARGET_IMAGE"
state_put SSH_IMAGE_ID "$SSH_IMAGE_ID"
state_put HTTP_IMAGE_ID "$HTTP_IMAGE_ID"
state_put NETWORK_NAME "$NETWORK_NAME"
state_put SSH_TARGET_NAME "$SSH_TARGET_NAME"
state_put HTTP_TARGET_NAME "$HTTP_TARGET_NAME"
state_put CONTROL_NAME "$CONTROL_NAME"
state_put SSH_PROXY_NAME "$SSH_PROXY_NAME"
state_put HTTP_PROXY_NAME "$HTTP_PROXY_NAME"
state_put CONTROL_PORT "$CONTROL_PORT"
state_put SSH_PORT "$SSH_PORT"
state_put HTTP_PORT "$HTTP_PORT"
state_put PROXY_HOST_KEY_FINGERPRINT "$PROXY_HOST_KEY_FINGERPRINT"

wait_for_control_state initial "$ARTIFACT_DIR/control-state-initial.json"

token_mode="$(stat -c '%a:%u:%g' "$PRIVATE_DIR/ssh-token")"
http_token_mode="$(stat -c '%a:%u:%g' "$PRIVATE_DIR/http-token")"
[[ "$token_mode" == '600:65532:65532' && "$http_token_mode" == '600:65532:65532' ]]

trap - EXIT
echo "Full proxy PoC ready: $STATE_FILE"
