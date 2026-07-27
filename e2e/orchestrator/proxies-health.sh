#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
run_id="$(require_run_id "${1:-}")"
load_run "$run_id"
[[ "$NYABASE_E2E_PROFILE" == full || "$NYABASE_E2E_PROFILE" == recovery ]] \
  || die 'proxy health requires a proxy-enabled profile'
# shellcheck disable=SC1090
source "$NYABASE_E2E_RUNTIME_DIR/build.env"

assert_proxy() {
  local name="$1" component="$2" image_id="$3" expected_ip="$4" token_file="$5"
  [[ "$(docker inspect "$name" --format '{{.State.Running}}')" == true ]] \
    || die "$component is not running"
  [[ "$(docker inspect "$name" --format '{{index .Config.Labels "io.nyabase.e2e.run-id"}}')" == "$run_id" ]] \
    || die "$component run ownership mismatch"
  [[ "$(docker inspect "$name" --format '{{.Image}}')" == "$image_id" ]] \
    || die "$component is not the current Full build image"
  [[ "$(docker inspect "$name" --format '{{.Config.User}}')" == '65532:65532' ]] \
    || die "$component is not uid/gid 65532"
  [[ "$(docker inspect "$name" --format '{{.HostConfig.ReadonlyRootfs}}')" == true ]] \
    || die "$component root filesystem is writable"
  [[ "$(docker inspect "$name" --format '{{json .HostConfig.CapDrop}}')" == '["ALL"]' ]] \
    || die "$component did not drop all capabilities"
  docker inspect "$name" --format '{{json .HostConfig.SecurityOpt}}' \
    | grep -q 'no-new-privileges'
  [[ "$(docker inspect "$name" --format "{{with index .NetworkSettings.Networks \"$NYABASE_E2E_NETWORK\"}}{{.IPAddress}}{{end}}")" == "$expected_ip" ]] \
    || die "$component address mismatch"
  [[ "$(stat -c '%a:%u:%g' "$token_file")" == '600:65532:65532' ]] \
    || die "$component token file ownership or mode mismatch"
  ! docker inspect "$name" --format '{{range .Mounts}}{{println .Source "->" .Destination}}{{end}}' \
    | grep -Eq 'docker\.sock|/var/run/docker'
  ! docker inspect "$name" --format '{{range .Config.Env}}{{println .}}{{end}}' \
    | grep -Eq '^(SSH_PROXY_TOKEN|HTTP_PROXY_TOKEN)='
}

assert_proxy "$NYABASE_E2E_PREFIX-ssh-proxy" ssh-proxy "$SSH_PROXY_IMAGE_ID" \
  "$NYABASE_E2E_SSH_PROXY_IP" "$NYABASE_E2E_RUNTIME_DIR/proxies/ssh-token"
assert_proxy "$NYABASE_E2E_PREFIX-http-proxy" http-proxy "$HTTP_PROXY_IMAGE_ID" \
  "$NYABASE_E2E_HTTP_PROXY_IP" "$NYABASE_E2E_RUNTIME_DIR/proxies/http-token"
NODE_EXTRA_CA_CERTS="$NYABASE_E2E_RUNTIME_DIR/certs/ca.crt" \
  node "$E2E_ROOT/e2e/orchestrator/proxy-health.mjs" "$NYABASE_E2E_RUNTIME_DIR" 120000
log 'proxy health PASS: hardened current binaries and real Backend snapshot control are online'
