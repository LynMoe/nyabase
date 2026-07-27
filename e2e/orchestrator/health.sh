#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
run_id="$(require_run_id "${1:-}")"
load_run "$run_id"
export_compose_state

ca="$NYABASE_E2E_RUNTIME_DIR/certs/ca.crt"
curl --fail --silent --show-error --cacert "$ca" \
  "$NYABASE_E2E_PUBLIC_URL/api/public/settings" >/dev/null
curl --fail --silent --show-error --cacert "$ca" \
  "$NYABASE_E2E_RATE_LIMIT_PUBLIC_URL/api/public/settings" >/dev/null
curl --noproxy '*' --fail --silent --show-error --cacert "$ca" \
  "https://registry:5000/v2/" --resolve "registry:5000:${NYABASE_E2E_REGISTRY_IP}" >/dev/null

expected_backend_id="$(docker image inspect "$NYABASE_E2E_BACKEND_IMAGE" --format '{{.Id}}')"
for role in api gateway worker; do
  runtime="$NYABASE_E2E_PREFIX-backend-$role-1"
  runtime_image="$(docker inspect "$runtime" --format '{{.Image}}')"
  [[ "$runtime_image" == "$expected_backend_id" ]] \
    || die "live $role runtime is not the current Backend image"
  [[ "$(docker inspect "$runtime" --format '{{.State.Running}}')" == true ]] \
    || die "live $role runtime is not running"
  docker inspect "$runtime" --format '{{range .Config.Env}}{{println .}}{{end}}' \
    | grep -Fxq "NYABASE_RUNTIME_ROLE=$role" \
    || die "live $role runtime role fingerprint mismatch"
  docker inspect "$runtime" --format '{{range .Config.Env}}{{println .}}{{end}}' \
    | grep -Fxq "DB_MIGRATIONS_RUN=true" \
    || die "live $role migration ownership fingerprint mismatch"
done

declare -A service_images=(
  [postgres]='postgres:18.4-bookworm'
  [redis]='redis:8.2-bookworm'
  [victoriametrics]='victoriametrics/victoria-metrics:v1.148.0'
  [vmagent]='victoriametrics/vmagent:v1.148.0'
)
for service in postgres redis victoriametrics vmagent; do
  container="$NYABASE_E2E_PREFIX-$service-1"
  [[ "$(docker inspect "$container" --format '{{.State.Health.Status}}')" == healthy ]] \
    || die "$service dependency is not healthy"
  [[ "$(docker inspect "$container" --format '{{.Config.Image}}')" == "${service_images[$service]}" ]] \
    || die "$service dependency image fingerprint mismatch"
done

postgres_migration_digest="$(
  node "$E2E_ROOT/e2e/orchestrator/fixture-evidence.mjs" verify-migration \
    "$NYABASE_E2E_RUNTIME_DIR"
)"
[[ "$postgres_migration_digest" =~ ^[0-9a-f]{64}$ ]] \
  || die "PostgreSQL migration image/database fingerprint is invalid"
redis_persistence="$(docker exec "$NYABASE_E2E_PREFIX-redis-1" \
  sh -ec 'REDISCLI_AUTH="$0" redis-cli --raw CONFIG GET save; REDISCLI_AUTH="$0" redis-cli --raw CONFIG GET appendonly' \
  "$run_id")"
[[ "$redis_persistence" == $'save\n\nappendonly\nno' ]] \
  || die "Redis disposable-cache persistence fingerprint mismatch"
rate_limit_edge_ip="$(docker inspect "$NYABASE_E2E_PREFIX-rate-limit-edge-1" \
  --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')"
[[ "$rate_limit_edge_ip" == "$NYABASE_E2E_RATE_LIMIT_EDGE_IP" ]] \
  || die "isolated login-rate-limit edge address mismatch: $rate_limit_edge_ip"

machine_ids=()
for node_key in node1 node2; do
  name="$NYABASE_E2E_PREFIX-$node_key"
  docker inspect "$name" >/dev/null
  docker exec "$name" systemctl is-active --quiet nyabase-agent.service
  docker exec "$name" systemctl is-active --quiet nyabase-docker.service
  docker exec "$name" findmnt -n -o FSTYPE,OPTIONS --mountpoint /mnt/nyabase-xfs \
    | grep -Eq '^xfs .*(pquota|prjquota)'
  info="$(docker exec "$name" docker -H unix:///run/nyabase-agent/docker.sock info \
    --format '{{.Driver}}|{{.DockerRootDir}}|{{.CgroupVersion}}|{{.CgroupDriver}}')"
  [[ "$info" == 'overlay2|/var/lib/nyabase-docker|2|systemd' ]] \
    || die "$node_key managed dockerd identity mismatch: $info"
  machine_ids+=("$(docker exec "$name" cat /etc/machine-id)")
  docker exec "$name" systemctl show nyabase-docker.service --property=ExecStart --value \
    | grep -q '/usr/sbin/dockerd'
  docker exec "$name" sh -ec 'command -v mount.nfs >/dev/null'
  docker exec "$name" sh -ec 'command -v mount.ceph >/dev/null'
done
[[ "${machine_ids[0]}" != "${machine_ids[1]}" ]] || die "machine ids are duplicated"

independent_client="$NYABASE_E2E_PREFIX-independent-client"
independent_ip="$(docker inspect "$independent_client" \
  --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')"
[[ "$independent_ip" == "$NYABASE_E2E_PROBE_IP" ]] \
  || die "independent network client address mismatch: $independent_ip"
independent_label="$(docker inspect "$independent_client" \
  --format '{{index .Config.Labels "io.nyabase.e2e.run-id"}}')"
[[ "$independent_label" == "$run_id" ]] || die "independent network client run label mismatch"
independent_ready=false
for _ in $(seq 1 30); do
  if [[ "$(docker exec "$independent_client" \
    wget -q -T 3 -O - http://127.0.0.1:8080/ 2>/dev/null || true)" \
    == "nyabase-independent-${run_id}" ]]; then
    independent_ready=true
    break
  fi
  sleep 0.2
done
[[ "$independent_ready" == true ]] || die "independent network client HTTP fixture is not ready"

NODE_EXTRA_CA_CERTS="$ca" node "$E2E_ROOT/e2e/orchestrator/api-health.mjs" \
  "$NYABASE_E2E_RUNTIME_DIR" 120000
if [[ "$NYABASE_E2E_PROFILE" == full ]]; then
  "$E2E_ROOT/e2e/orchestrator/storage-health.sh" "$run_id"
fi
if [[ "$NYABASE_E2E_PROFILE" == full || "$NYABASE_E2E_PROFILE" == recovery ]]; then
  "$E2E_ROOT/e2e/orchestrator/proxies-health.sh" "$run_id"
fi
log "health PASS: current split API/Gateway/Worker image, exact PostgreSQL migration digest $postgres_migration_digest, disposable Redis, vmagent/VM, TLS edges, registry, WSS Agents and exact CPU nodes"
