#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
run_id="$(require_run_id "${1:-}")"

if [[ ! -s "$(runtime_dir_for "$run_id")/state.env" ]]; then
  "$E2E_ROOT/e2e/orchestrator/build.sh" "$run_id"
fi
load_run "$run_id"
export_compose_state

completed=false
cleanup_failed_up() {
  local rc=$?
  if [[ "$completed" != true && "${NYABASE_E2E_PARENT_OWNS_CLEANUP:-false}" != true ]]; then
    log "up failed; tearing down only resources owned by $run_id" >&2
    "$E2E_ROOT/e2e/orchestrator/diagnose.sh" "$run_id" >/dev/null 2>&1 || true
    "$E2E_ROOT/e2e/orchestrator/down.sh" "$run_id" --keep-runtime >/dev/null 2>&1 || true
  fi
  exit "$rc"
}
trap cleanup_failed_up EXIT
trap 'exit 130' INT TERM HUP

[[ -s "$NYABASE_E2E_RUNTIME_DIR/build.env" ]] || die "run build before up"
docker image inspect "$NYABASE_E2E_BACKEND_IMAGE" >/dev/null 2>&1 || die "backend image is missing; rerun build"
docker image inspect "$NYABASE_E2E_NODE_IMAGE" >/dev/null 2>&1 || die "node image is missing; rerun build"
if [[ "$NYABASE_E2E_PROFILE" == full || "$NYABASE_E2E_PROFILE" == recovery ]]; then
  for image in "$NYABASE_E2E_SSH_PROXY_IMAGE" "$NYABASE_E2E_HTTP_PROXY_IMAGE"; do
    docker image inspect "$image" >/dev/null 2>&1 \
      || die "proxy-enabled profile image is missing; rerun build: $image"
  done
fi
if [[ "$NYABASE_E2E_PROFILE" == full ]]; then
  for image in "$NYABASE_E2E_NFS_IMAGE" "$NYABASE_E2E_CEPH_IMAGE" \
    "$NYABASE_E2E_STORAGE_CLIENT_IMAGE" "$NYABASE_E2E_PROXY_TARGET_IMAGE"; do
    docker image inspect "$image" >/dev/null 2>&1 \
      || die "Full profile image is missing; rerun build: $image"
  done
fi

"$E2E_ROOT/e2e/orchestrator/certs.sh" "$run_id"

# Backend runs as UID 10001 and NODE_OPTIONS --requires this bind-mounted shim.
# Working-tree mode can drift to 0600 under a restrictive umask; normalize to
# world-readable before Compose mounts it read-only into the Backend containers.
clock_shim="$E2E_ROOT/e2e/orchestrator/backend-clock-shim.cjs"
[[ -f "$clock_shim" ]] || die "missing Backend clock shim: $clock_shim"
chmod 0644 "$clock_shim"
mode="$(stat -c '%a' "$clock_shim")"
[[ "$((8#$mode & 4))" -ne 0 ]] \
  || die "Backend clock shim mode $mode is not other-readable for UID 10001"

if [[ ! -s "$NYABASE_E2E_RUNTIME_DIR/secrets.env" ]]; then
  (
    umask 077
    install -m 0600 /dev/null "$NYABASE_E2E_RUNTIME_DIR/secrets.env"
    printf '%s\n' \
      "ADMIN_INIT_PASSWORD=$(openssl rand -hex 24)" \
      "JWT_SECRET=$(openssl rand -hex 32)" \
      "HTTP_PROXY_TOKEN=$(openssl rand -hex 32)" \
      "SSH_PROXY_TOKEN=$(openssl rand -hex 32)" \
      "SSH_KEY_SECRET=$(openssl rand -hex 32)" > "$NYABASE_E2E_RUNTIME_DIR/secrets.env"
  )
fi
# shellcheck disable=SC1090
source "$NYABASE_E2E_RUNTIME_DIR/secrets.env"
proxy_public_host=""
if [[ "$NYABASE_E2E_PROFILE" == full || "$NYABASE_E2E_PROFILE" == recovery ]]; then
  proxy_public_host="$NYABASE_E2E_SSH_PROXY_IP"
fi

backend_config_dir="$NYABASE_E2E_RUNTIME_DIR/backend-config"
rm -rf "$backend_config_dir"
# Backend containers run as UID/GID 10001 and bind-mount this directory (api) or
# config.yaml (gateway/worker). Match production ownership so the non-root
# process can read the file even when the host umask would otherwise leave
# root-owned 0600 content.
install -d -m 0755 -o 10001 -g 10001 "$backend_config_dir"
# The capacity boundary scenario creates and then removes 64 real containers.
# Its 35-minute behavior-plus-cleanup budget must fit inside one immutable
# APIRequestContext bearer token; auth rotation itself is covered separately.
umask 022
printf '%s\n' \
  'runtime:' \
  '  nodeEnv: production' \
  '  role: all' \
  'server:' \
  '  port: 3001' \
  '  corsOrigin: ""' \
  'branding:' \
  '  title: nyabase E2E' \
  "  description: real CPU run ${run_id}" \
  'auth:' \
  "  jwtSecret: ${JWT_SECRET}" \
  '  jwtExpiresIn: 1h' \
  '  refreshTokenExpiresDays: 1' \
  "  adminInitPassword: ${ADMIN_INIT_PASSWORD}" \
  'database:' \
  "  url: \"postgresql://nyabase:${run_id}@postgres:5432/nyabase\"" \
  '  poolMax: 12' \
  '  idleTimeoutMs: 30000' \
  '  statementTimeoutMs: 30000' \
  '  migrationsRun: true' \
  'redis:' \
  "  url: \"redis://:${run_id}@redis:6379/0\"" \
  "  keyPrefix: \"nyabase:${run_id}:\"" \
  'metrics:' \
  '  victoriaMetricsUrl: http://victoriametrics:8428' \
  '  vmagentUrl: http://vmagent:8429' \
  'http:' \
  "  proxyToken: ${HTTP_PROXY_TOKEN}" \
  'ssh:' \
  "  keyEncryptionSecret: ${SSH_KEY_SECRET}" \
  "  proxyToken: ${SSH_PROXY_TOKEN}" \
  "  proxyPublicHost: \"${proxy_public_host}\"" \
  '  proxyPublicPort: 2222' \
  '  proxySnapshotStaleMs: 300000' > "$backend_config_dir/config.yaml"
chown 10001:10001 "$backend_config_dir/config.yaml"
chmod 0400 "$backend_config_dir/config.yaml"
config_owner="$(stat -c '%u:%g' "$backend_config_dir/config.yaml")"
config_mode="$(stat -c '%a' "$backend_config_dir/config.yaml")"
[[ "$config_owner" == '10001:10001' && "$config_mode" == '400' ]] \
  || die "Backend config.yaml must be 10001:10001 mode 0400 (got $config_owner mode $config_mode)"

install -m 0600 "$NYABASE_E2E_RUNTIME_DIR/state.env" \
  "$NYABASE_E2E_RUNTIME_DIR/compose.env"
validate_compose_state

manifest_phase control_plane_starting
node "$E2E_ROOT/e2e/orchestrator/fixture-evidence.mjs" pre-migration \
  "$NYABASE_E2E_RUNTIME_DIR"
docker_compose_for_run create
mapfile -t compose_services < <(
  docker_compose_for_run config --services | sed '/^$/d' | LC_ALL=C sort
)
mapfile -t compose_containers < <(
  docker_compose_for_run ps -a --format '{{.Name}}' | sed '/^$/d' | LC_ALL=C sort
)
[[ "${#compose_services[@]}" -gt 0 ]] || die "Compose declared no control-plane services"
[[ "${#compose_containers[@]}" -eq "${#compose_services[@]}" ]] \
  || die "Compose container inventory is incomplete after create"
for required_service in postgres redis victoriametrics vmagent backend-api \
  backend-gateway backend-worker edge rate-limit-edge registry; do
  printf '%s\n' "${compose_services[@]}" | grep -Fxq "$required_service" \
    || die "required Compose service is absent: $required_service"
done
for compose_container in "${compose_containers[@]}"; do
  [[ "$compose_container" == "$NYABASE_E2E_PREFIX-"* ]] \
    || die "Compose created an out-of-run container: $compose_container"
  [[ "$(docker inspect "$compose_container" \
    --format '{{index .Config.Labels "io.nyabase.e2e.run-id"}}')" == "$run_id" ]] \
    || die "Compose container lacks exact run ownership: $compose_container"
  manifest_resource container "$compose_container"
done
manifest_resource network "$NYABASE_E2E_NETWORK"
manifest_resource volume "$NYABASE_E2E_PREFIX-postgres-data"
manifest_resource volume "$NYABASE_E2E_PREFIX-vm-data"
manifest_resource volume "$NYABASE_E2E_PREFIX-vmagent-data"
manifest_resource volume "$NYABASE_E2E_PREFIX-registry-data"
node "$E2E_ROOT/e2e/orchestrator/fixture-evidence.mjs" empty-migration-volume \
  "$NYABASE_E2E_RUNTIME_DIR"
docker_compose_for_run up -d

if ! wait_for_https "$NYABASE_E2E_PUBLIC_URL/api/public/settings" \
  "$NYABASE_E2E_RUNTIME_DIR/certs/ca.crt" 120; then
  docker_compose_for_run logs --no-color --tail 100 \
    postgres redis backend-api backend-gateway backend-worker edge >&2 || true
  die "production split control-plane/TLS edge readiness timed out"
fi
if ! wait_for_https "$NYABASE_E2E_RATE_LIMIT_PUBLIC_URL/api/public/settings" \
  "$NYABASE_E2E_RUNTIME_DIR/certs/ca.crt" 120; then
  docker_compose_for_run logs --no-color --tail 100 backend-api rate-limit-edge >&2 || true
  die "isolated login-rate-limit TLS edge readiness timed out"
fi

# Prove the SQL-first migration ledger and required PostgreSQL schemas through
# the exact run-owned PostgreSQL container. The inspection is read-only and
# does not stop API, Gateway, Worker, or interrupt the Agent transport.
node "$E2E_ROOT/e2e/orchestrator/fixture-evidence.mjs" capture-migration \
  "$NYABASE_E2E_RUNTIME_DIR"
if ! wait_for_https "$NYABASE_E2E_PUBLIC_URL/api/public/settings" \
  "$NYABASE_E2E_RUNTIME_DIR/certs/ca.crt" 120; then
  docker_compose_for_run logs --no-color --tail 100 postgres backend-api edge >&2 || true
  die "production API did not remain healthy after PostgreSQL migration proof"
fi

if [[ "$NYABASE_E2E_PROFILE" == full ]]; then
  manifest_phase full_storage_starting
  "$E2E_ROOT/e2e/orchestrator/storage-up.sh" "$run_id"
fi
if [[ "$NYABASE_E2E_PROFILE" == full || "$NYABASE_E2E_PROFILE" == recovery ]]; then
  manifest_phase proxy_fixtures_starting
  "$E2E_ROOT/e2e/orchestrator/proxies-up.sh" "$run_id"
fi

NODE_EXTRA_CA_CERTS="$NYABASE_E2E_RUNTIME_DIR/certs/ca.crt" \
  node "$E2E_ROOT/e2e/orchestrator/register.mjs" "$NYABASE_E2E_RUNTIME_DIR"

start_node() {
  local node_key="$1" ip="$2"
  local name="$NYABASE_E2E_PREFIX-$node_key"
  local config="$NYABASE_E2E_RUNTIME_DIR/agents/${node_key}.yaml"
  docker run -d \
    --name "$name" --hostname "$name" \
    --label "io.nyabase.e2e.run-id=$run_id" \
    --label 'io.nyabase.e2e.managed=true' \
    --label "io.nyabase.e2e.component=$node_key" \
    --privileged --cgroupns=private \
    --tmpfs /run --tmpfs /run/lock --tmpfs /tmp \
    --network "$NYABASE_E2E_NETWORK" --ip "$ip" \
    --mount "type=bind,src=$config,dst=/run/nyabase-e2e/agent.yaml,readonly" \
    --mount "type=bind,src=$NYABASE_E2E_RUNTIME_DIR/certs/ca.crt,dst=/run/nyabase-e2e/ca.crt,readonly" \
    "$NYABASE_E2E_NODE_IMAGE" >/dev/null
  manifest_resource container "$name"

  local state i
  for i in $(seq 1 60); do
    state="$(docker exec "$name" systemctl is-system-running 2>/dev/null || true)"
    [[ "$state" == running || "$state" == degraded ]] && break
    sleep 1
  done
  [[ "$state" == running || "$state" == degraded ]] || die "$node_key systemd did not become ready"

  docker exec \
    -e "NYABASE_E2E_NODE_ID=$node_key" \
    -e "NYABASE_E2E_RUN_ID=$run_id" \
    "$name" /usr/local/libexec/nyabase-e2e/setup-node
}

manifest_phase nodes_starting
start_node node1 "$NYABASE_E2E_NODE1_IP"
start_node node2 "$NYABASE_E2E_NODE2_IP"

machine1="$(docker exec "$NYABASE_E2E_PREFIX-node1" cat /etc/machine-id)"
machine2="$(docker exec "$NYABASE_E2E_PREFIX-node2" cat /etc/machine-id)"
[[ "$machine1" != "$machine2" ]] || die "node machine ids are not unique"

independent_client="$NYABASE_E2E_PREFIX-independent-client"
independent_marker="nyabase-independent-${run_id}"
docker run -d \
  --name "$independent_client" \
  --label "io.nyabase.e2e.run-id=$run_id" \
  --label 'io.nyabase.e2e.managed=true' \
  --label 'io.nyabase.e2e.component=independent-network-client' \
  --network "$NYABASE_E2E_NETWORK" --ip "$NYABASE_E2E_PROBE_IP" \
  --entrypoint /bin/sh alpine:latest -ec \
  "while true; do printf 'HTTP/1.1 200 OK\\r\\nContent-Length: ${#independent_marker}\\r\\nConnection: close\\r\\n\\r\\n${independent_marker}' | nc -l -p 8080; done" \
  >/dev/null
manifest_resource container "$independent_client"

"$E2E_ROOT/e2e/orchestrator/health.sh" "$run_id"

manifest_phase seeding
docker image inspect alpine:latest >/dev/null 2>&1 \
  || die "the doctor workload source alpine:latest is unavailable"
node1="$NYABASE_E2E_PREFIX-node1"
inner_docker=(docker exec "$node1" docker -H unix:///run/nyabase-agent/docker.sock)
docker save alpine:latest \
  | docker exec -i "$node1" docker -H unix:///run/nyabase-agent/docker.sock load >/dev/null
workload_tag="registry:5000/${run_id}/workload:immutable"
"${inner_docker[@]}" tag alpine:latest "$workload_tag"
"${inner_docker[@]}" push "$workload_tag" >/dev/null
workload_ref="$("${inner_docker[@]}" image inspect "$workload_tag" \
  --format '{{index .RepoDigests 0}}')"
[[ "$workload_ref" == "registry:5000/${run_id}/workload@sha256:"* ]] \
  || die "registry did not return an immutable workload digest"
workload_image_id="$("${inner_docker[@]}" image inspect "$workload_tag" --format '{{.Id}}')"
[[ "$workload_image_id" == sha256:* ]] || die "managed dockerd returned an invalid workload image id"
manifest_resource inner-image "$workload_ref"

# Publish a second, real run-scoped tag for UI image-create coverage. The
# product deliberately enforces one logical owner per canonical image tag and
# rejects digests, so the browser lifecycle cannot reuse workload_tag or fake
# a non-existent registry reference.
ui_workload_tag="registry:5000/${run_id}/ui-workload:immutable"
"${inner_docker[@]}" tag alpine:latest "$ui_workload_tag"
"${inner_docker[@]}" push "$ui_workload_tag" >/dev/null
ui_workload_ref="$(
  "${inner_docker[@]}" image inspect "$ui_workload_tag" \
    --format '{{range .RepoDigests}}{{println .}}{{end}}' \
    | rg -m1 "^registry:5000/${run_id}/ui-workload@sha256:"
)"
[[ "$ui_workload_ref" == "registry:5000/${run_id}/ui-workload@sha256:"* ]] \
  || die "registry did not return the UI workload digest"
manifest_resource inner-image "$ui_workload_ref"

NODE_EXTRA_CA_CERTS="$NYABASE_E2E_RUNTIME_DIR/certs/ca.crt" \
  node "$E2E_ROOT/e2e/orchestrator/seed.mjs" \
    "$NYABASE_E2E_RUNTIME_DIR" "$workload_tag" "$workload_ref" "$workload_image_id" \
    "$ui_workload_tag" "$ui_workload_ref"

if [[ "$NYABASE_E2E_PROFILE" == full ]]; then
  docker save "$NYABASE_E2E_PROXY_TARGET_IMAGE" \
    | docker exec -i "$node1" docker -H unix:///run/nyabase-agent/docker.sock load >/dev/null
  proxy_target_tag="registry:5000/${run_id}/proxy-target:immutable"
  "${inner_docker[@]}" tag "$NYABASE_E2E_PROXY_TARGET_IMAGE" "$proxy_target_tag"
  "${inner_docker[@]}" push "$proxy_target_tag" >/dev/null
  proxy_target_ref="$("${inner_docker[@]}" image inspect "$proxy_target_tag" \
    --format '{{range .RepoDigests}}{{println .}}{{end}}' \
    | rg -m1 "^registry:5000/${run_id}/proxy-target@sha256:")"
  [[ "$proxy_target_ref" == "registry:5000/${run_id}/proxy-target@sha256:"* ]] \
    || die 'registry did not return the immutable Full proxy target digest'
  proxy_target_image_id="$("${inner_docker[@]}" image inspect "$proxy_target_tag" --format '{{.Id}}')"
  [[ "$proxy_target_image_id" == sha256:* ]] || die 'Full proxy target image ID is invalid'
  manifest_resource inner-image "$proxy_target_ref"
  NODE_EXTRA_CA_CERTS="$NYABASE_E2E_RUNTIME_DIR/certs/ca.crt" \
    node "$E2E_ROOT/e2e/orchestrator/seed-full.mjs" \
      "$NYABASE_E2E_RUNTIME_DIR" "$proxy_target_tag" "$proxy_target_ref" \
      "$proxy_target_image_id"

  for node_key in node1 node2; do
    node_name="$NYABASE_E2E_PREFIX-$node_key"
    observed_proxy_image_id="$(docker exec "$node_name" \
      docker -H unix:///run/nyabase-agent/docker.sock image inspect \
        "$proxy_target_tag" --format '{{.Id}}')"
    [[ "$observed_proxy_image_id" == "$proxy_target_image_id" ]] \
      || die "$node_key Full proxy target image identity mismatch"
    manifest_resource node-workload-image \
      "$node_key:$proxy_target_image_id@$proxy_target_ref"
  done
  manifest_resource product-image "${run_id}-proxy-target"
fi

for node_key in node1 node2; do
  node_name="$NYABASE_E2E_PREFIX-$node_key"
  node_image_id="$(docker exec "$node_name" \
    docker -H unix:///run/nyabase-agent/docker.sock image inspect \
      "$workload_tag" --format '{{.Id}}')"
  node_repo_digests="$(docker exec "$node_name" \
    docker -H unix:///run/nyabase-agent/docker.sock image inspect \
      "$workload_tag" --format '{{json .RepoDigests}}')"
  [[ "$node_image_id" == "$workload_image_id" ]] \
    || die "$node_key pulled workload image id $node_image_id, expected $workload_image_id"
  [[ "$node_repo_digests" == *"\"$workload_ref\""* ]] \
    || die "$node_key workload tag does not resolve to the expected registry digest"
  manifest_resource node-workload-image "$node_key:$workload_image_id@$workload_ref"
done
manifest_resource product-image "${run_id}-workload"

# Do not advertise a shared L2 capability from configuration alone. Exercise
# two same-node paths, both cross-node directions, and an independent outer
# bridge sibling against real inner macvlan namespaces, then prove every
# temporary inner probe absent. The manifest-owned independent client remains
# available for product-container reachability tests and is removed by down.
node "$E2E_ROOT/e2e/orchestrator/network-l2-probe.mjs" \
  "$NYABASE_E2E_RUNTIME_DIR" "$workload_tag"

NODE_EXTRA_CA_CERTS="$NYABASE_E2E_RUNTIME_DIR/certs/ca.crt" \
  node "$E2E_ROOT/e2e/orchestrator/fixture-evidence.mjs" capture \
    "$NYABASE_E2E_RUNTIME_DIR"

if [[ "$NYABASE_E2E_PROFILE" == recovery ]]; then
  node "$E2E_ROOT/e2e/orchestrator/capture-recovery-proof.mjs" \
    "$NYABASE_E2E_RUNTIME_DIR"
  manifest_resource evidence recovery-proof.json
  "$E2E_ROOT/e2e/orchestrator/health.sh" "$run_id"
fi

manifest_phase ready
completed=true
trap - EXIT INT TERM HUP
log "up PASS: profile=$NYABASE_E2E_PROFILE $NYABASE_E2E_PUBLIC_URL, isolated login-rate-limit edge and real CPU topology are ready"
