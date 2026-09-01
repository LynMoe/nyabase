#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/common.sh"

run_id="$(require_run_id "${1:-}")"

incus_cmd() {
  local ssh_target="$1"
  shift
  if [[ -n "$ssh_target" ]]; then
    ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 \
      "$ssh_target" incus "$@"
  else
    incus "$@"
  fi
}

is_leftover_instance() {
  local name="$1"
  case "$name" in
    e2e-*|nyabase-preflight-*|nyc-*|nyv-*) return 0 ;;
    *) return 1 ;;
  esac
}

lab_ssh_targets() {
  if [[ -z "${E2E_LAB_SERVERS_FILE:-}" || ! -f "${E2E_LAB_SERVERS_FILE}" ]]; then
    return 0
  fi
  python3 - <<PY
import json
from pathlib import Path
path = Path("${E2E_LAB_SERVERS_FILE}")
try:
    data = json.loads(path.read_text())
except Exception:
    raise SystemExit(0)
for entry in data if isinstance(data, list) else []:
    ssh = entry.get("ssh") if isinstance(entry, dict) else None
    if isinstance(ssh, str) and ssh.strip():
        print(ssh.strip())
PY
}

sweep_host() {
  local ssh_target="${1:-}"
  local label="${ssh_target:-local}"

  local names
  names="$(incus_cmd "$ssh_target" list --format csv -c n 2>/dev/null || true)"
  while IFS= read -r name; do
    [[ -z "$name" ]] && continue
    if is_leftover_instance "$name"; then
      log "sweep leftover instance ${label}:$name"
      incus_cmd "$ssh_target" delete --force "$name" >/dev/null 2>&1 || true
    fi
  done <<< "$names"

  local pools
  pools="$(incus_cmd "$ssh_target" storage list --format csv -c n 2>/dev/null || true)"
  while IFS= read -r pool; do
    [[ -z "$pool" ]] && continue
    local volume_json
    volume_json="$(incus_cmd "$ssh_target" storage volume list "$pool" --format json 2>/dev/null || echo '[]')"
    printf '%s\n' "$volume_json" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    raise SystemExit(0)
items = data if isinstance(data, list) else []
for entry in items:
    if not isinstance(entry, dict):
        continue
    name = str(entry.get("name") or "")
    typ = str(entry.get("type") or "")
    if typ != "custom" or not name:
        continue
    if name.startswith("e2e-") or name.startswith("nyv-"):
        print(name)
' | while IFS= read -r vol_name; do
      [[ -z "$vol_name" ]] && continue
      log "sweep leftover volume ${label}:$pool/$vol_name"
      incus_cmd "$ssh_target" storage volume delete "$pool" "$vol_name" >/dev/null 2>&1 || true
    done
  done <<< "$pools"
}

sweep_host ""

while IFS= read -r ssh_target; do
  [[ -z "$ssh_target" ]] && continue
  sweep_host "$ssh_target"
done < <(lab_ssh_targets)

node "$SCRIPT_DIR/leftover-inventory.mjs"

log "incus leftover sweep finished for $run_id"
