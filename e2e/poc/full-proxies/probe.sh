#!/usr/bin/env bash

set -euo pipefail
umask 077

POC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$POC_DIR/lib.sh"
poc_init
load_state

for command in cmp curl date docker grep paste ps sftp sha256sum ssh ssh-keyscan stat; do
  require_command "$command"
done

for container in "$SSH_PROXY_NAME" "$HTTP_PROXY_NAME" "$CONTROL_NAME" "$SSH_TARGET_NAME" "$HTTP_TARGET_NAME"; do
  [[ "$(docker inspect --format '{{.State.Running}}' "$container")" == true ]]
done

HTTP_RESPONSE_FILE="$ARTIFACT_DIR/http-response.json"
HTTP_STATUS="$(curl --silent --show-error --output "$HTTP_RESPONSE_FILE" \
  --write-out '%{http_code}' --header 'Host: app.poc.test' \
  "http://127.0.0.1:${HTTP_PORT}/hello")"
[[ "$HTTP_STATUS" == 200 ]]
node -e "const v=require('fs').readFileSync(process.argv[1],'utf8');const j=JSON.parse(v);if(j.ok!==true||j.marker!=='nyabase-http-poc')process.exit(1)" "$HTTP_RESPONSE_FILE"

KNOWN_HOSTS="$PRIVATE_DIR/known_hosts"
for attempt in $(seq 1 40); do
  if ssh-keyscan -T 2 -p "$SSH_PORT" 127.0.0.1 >"$KNOWN_HOSTS" 2>/dev/null \
    && [[ -s "$KNOWN_HOSTS" ]]; then
    break
  fi
  sleep 0.25
done
[[ -s "$KNOWN_HOSTS" ]]
scanned_fingerprint="$(ssh-keygen -lf "$KNOWN_HOSTS" -E sha256 | awk 'NR==1 {print $2}')"
[[ "$scanned_fingerprint" == "$PROXY_HOST_KEY_FINGERPRINT" ]]

ssh_options=(
  -p "$SSH_PORT"
  -i "$PRIVATE_DIR/external-key"
  -o IdentitiesOnly=yes
  -o BatchMode=yes
  -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=$KNOWN_HOSTS"
  -o ConnectTimeout=10
  -o ConnectionAttempts=1
)

set +e
ssh_output="$(ssh "${ssh_options[@]}" alice.cpu-a.work@127.0.0.1 "printf 'nyabase-ssh-poc'")"
SSH_COMMAND_STATUS=$?
set -e
[[ "$SSH_COMMAND_STATUS" == 0 ]]
[[ "$ssh_output" == 'nyabase-ssh-poc' ]]

printf 'nyabase-sftp-poc\n' >"$PRIVATE_DIR/sftp-upload.txt"
printf 'put %q /tmp/nyabase-sftp-poc.txt\nget /tmp/nyabase-sftp-poc.txt %q\n' \
  "$PRIVATE_DIR/sftp-upload.txt" "$PRIVATE_DIR/sftp-download.txt" >"$PRIVATE_DIR/sftp.batch"
set +e
sftp -q -b "$PRIVATE_DIR/sftp.batch" -P "$SSH_PORT" \
  -o "IdentityFile=$PRIVATE_DIR/external-key" \
  -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o "UserKnownHostsFile=$KNOWN_HOSTS" -o ConnectTimeout=10 \
  alice.cpu-a.work@127.0.0.1
SFTP_STATUS=$?
set -e
[[ "$SFTP_STATUS" == 0 ]]
cmp "$PRIVATE_DIR/sftp-upload.txt" "$PRIVATE_DIR/sftp-download.txt"
SFTP_BYTES="$(stat -c '%s' "$PRIVATE_DIR/sftp-download.txt")"
SFTP_SHA256="$(sha256sum "$PRIVATE_DIR/sftp-download.txt" | awk '{print $1}')"

WS_LOG="$ARTIFACT_DIR/websocket-client.log"
node "$POC_DIR/websocket-client.mjs" \
  "ws://127.0.0.1:${HTTP_PORT}/socket" app.poc.test nyabase-ws-poc >"$WS_LOG" 2>&1 &
ws_pid=$!
printf '%s\n' "$ws_pid" >"$PRIVATE_DIR/websocket-client.pid"

SSH_SESSION_LOG="$ARTIFACT_DIR/ssh-established-session.log"
ssh "${ssh_options[@]}" alice.cpu-a.work@127.0.0.1 \
  "printf 'SESSION_READY\\n'; sleep 300" >"$SSH_SESSION_LOG" 2>&1 &
ssh_pid=$!
printf '%s\n' "$ssh_pid" >"$PRIVATE_DIR/ssh-session.pid"

wait_for_log() {
  local path="$1"
  local marker="$2"
  local pid="$3"
  local attempt
  for attempt in $(seq 1 100); do
    grep -Fq "$marker" "$path" 2>/dev/null && return 0
    kill -0 "$pid" 2>/dev/null || return 1
    sleep 0.1
  done
  return 1
}

wait_for_log "$WS_LOG" READY "$ws_pid"
wait_for_log "$SSH_SESSION_LOG" SESSION_READY "$ssh_pid"
wait_for_control_state active "$ARTIFACT_DIR/control-state-active.json"

revocation_started_ms="$(date +%s%3N)"
control_request POST /admin/revoke >"$ARTIFACT_DIR/revoke-response.json"
wait_for_control_state revoked "$ARTIFACT_DIR/control-state-revoked.json"

wait_for_exit() {
  local pid="$1"
  local attempt state
  for attempt in $(seq 1 100); do
    state="$( { ps -o stat= -p "$pid" 2>/dev/null || true; } | tr -d '[:space:]')"
    [[ -z "$state" || "$state" == Z* ]] && return 0
    sleep 0.1
  done
  return 1
}

wait_for_exit "$ws_pid"
wait_for_exit "$ssh_pid"
set +e
wait "$ws_pid"
ws_status=$?
wait "$ssh_pid"
ssh_status=$?
set -e
revocation_elapsed_ms=$(( $(date +%s%3N) - revocation_started_ms ))
REVOCATION_RESULT_FILE="$ARTIFACT_DIR/revocation-clients.json"
printf '{"elapsedMs":%d,"websocketExitStatus":%d,"sshExitStatus":%d}\n' \
  "$revocation_elapsed_ms" "$ws_status" "$ssh_status" >"$REVOCATION_RESULT_FILE"
[[ "$ws_status" == 0 ]]
(( revocation_elapsed_ms < 15000 ))
grep -Fq 'CLOSED:' "$WS_LOG"
wait_for_control_state quiescent "$ARTIFACT_DIR/control-state-quiescent.json"

http_after_status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --header 'Host: app.poc.test' "http://127.0.0.1:${HTTP_PORT}/hello")"
[[ "$http_after_status" == 404 ]]
if ssh "${ssh_options[@]}" alice.cpu-a.work@127.0.0.1 true >/dev/null 2>&1; then
  echo 'revoked SSH route unexpectedly accepted a new login' >&2
  exit 1
fi

docker inspect "$SSH_PROXY_NAME" >"$PRIVATE_DIR/ssh-proxy-inspect.json"
docker inspect "$HTTP_PROXY_NAME" >"$PRIVATE_DIR/http-proxy-inspect.json"
node "$POC_DIR/verify-hardening.mjs" \
  "$PRIVATE_DIR/ssh-proxy-inspect.json" "$PRIVATE_DIR/http-proxy-inspect.json" \
  "$ARTIFACT_DIR/hardening.json"

ssh_container_hash="$(docker exec "$SSH_PROXY_NAME" sha256sum /usr/local/bin/nyabase-proxy | awk '{print $1}')"
http_container_hash="$(docker exec "$HTTP_PROXY_NAME" sha256sum /usr/local/bin/nyabase-proxy | awk '{print $1}')"
[[ "$ssh_container_hash" == "$SSH_BINARY_HASH" ]]
[[ "$http_container_hash" == "$HTTP_BINARY_HASH" ]]

collect_logs
for secret_file in "$PRIVATE_DIR/ssh-token" "$PRIVATE_DIR/http-token" "$PRIVATE_DIR/admin-token"; do
  secret="$(<"$secret_file")"
  if grep -R -F -q -- "$secret" "$PRIVATE_DIR"/*-inspect.json "$LOG_DIR"; then
    echo 'a PoC token was found in inspect output or logs' >&2
    exit 1
  fi
done

export SOURCE_GIT_HEAD SSH_TREE_HASH HTTP_TREE_HASH SSH_BINARY_HASH HTTP_BINARY_HASH SSH_IMAGE_ID HTTP_IMAGE_ID
export CONTROL_STATE_INITIAL_FILE="$ARTIFACT_DIR/control-state-initial.json"
export CONTROL_STATE_ACTIVE_FILE="$ARTIFACT_DIR/control-state-active.json"
export CONTROL_STATE_REVOKED_FILE="$ARTIFACT_DIR/control-state-revoked.json"
export CONTROL_STATE_QUIESCENT_FILE="$ARTIFACT_DIR/control-state-quiescent.json"
export REVOCATION_RESULT_FILE
export HARDENING_FILE="$ARTIFACT_DIR/hardening.json"
export EVIDENCE_FILE="$ARTIFACT_DIR/evidence.json"
export SSH_CLIENT_VERSION="$(ssh -V 2>&1 | head -n 1)"
export SSH_SEND_ENV="$(ssh -G 127.0.0.1 2>/dev/null | awk '$1 == "sendenv" {print $2}' | paste -sd ',' -)"
export CURL_VERSION="$(curl --version | head -n 1)"
export SSH_COMMAND_STATUS SSH_COMMAND_OUTPUT="$ssh_output"
export SFTP_STATUS SFTP_BYTES SFTP_SHA256 HTTP_STATUS HTTP_RESPONSE_FILE
export WEBSOCKET_ECHO='echo:nyabase-ws-poc'
node "$POC_DIR/write-evidence.mjs"

echo "Full proxy PoC probes passed: $EVIDENCE_FILE"
