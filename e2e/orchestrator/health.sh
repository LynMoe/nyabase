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

backend_live_id="$(docker inspect "$NYABASE_E2E_PREFIX-backend-1" --format '{{.Image}}')"
expected_backend_id="$(docker image inspect "$NYABASE_E2E_BACKEND_IMAGE" --format '{{.Id}}')"
[[ "$backend_live_id" == "$expected_backend_id" ]] || die "live Backend is not the current run image"
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
  "$E2E_ROOT/e2e/orchestrator/proxies-health.sh" "$run_id"
fi
log "health PASS: current Backend, primary and isolated rate-limit TLS edges, TLS registry, unique nodes, independent client, WSS Agents and exact nested dockerd identities"
