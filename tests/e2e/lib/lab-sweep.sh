#!/usr/bin/env bash
# Runs ON a lab host (piped to `bash -s` by e2e.sh down). Removes only what one
# e2e run created there:
#   * instances whose Incus config user.nyabase.server_id is one of this run's
#     server ids (production labels every managed instance and preflight probe
#     with it), looked up among the instance names the run's DB recorded plus
#     every nyc-* / nyabase-preflight-* instance currently on the host;
#   * custom volumes named exactly as the run's DB recorded them;
#   * the run's agent unit and its /var/tmp directory (state, credential);
#   * the agent's `bridge nyabase_guard` nft table, once no other nyabase agent
#     runs on the host.
# Anything else on the host is left alone.
# Args: <server ids, comma separated> <instances, comma separated or ->
#       <pool/volume pairs, comma separated or -> <agent unit name>
set -uo pipefail
sids_csv="$1"; instances_csv="$2"; volumes_csv="$3"; agent_unit="$4"
rc=0

# Stop the agent first so nothing re-creates what is deleted below.
if [[ "$agent_unit" =~ ^nyabase-e2e-agent-[0-9]{14}-[0-9a-f]{4}-s[0-9]+$ ]]; then
  systemctl stop "$agent_unit" >/dev/null 2>&1 || true
  systemctl reset-failed "$agent_unit" >/dev/null 2>&1 || true
  rm -rf "/var/tmp/$agent_unit" || rc=1
fi

declare -A owners=() candidates=()
IFS=',' read -ra sids <<<"$sids_csv"
for sid in "${sids[@]}"; do
  [[ "$sid" =~ ^[0-9a-f-]{36}$ ]] || { echo "bad server id: $sid" >&2; exit 2; }
  owners[$sid]=1
  owners[${sid//-/}]=1 # the preflight probe stores the dash-less form
done

if [[ "$instances_csv" != "-" ]]; then
  IFS=',' read -ra recorded <<<"$instances_csv"
  for name in "${recorded[@]}"; do
    [[ "$name" =~ ^nyc-[0-9a-f]{32}$ ]] && candidates[$name]=1
  done
fi
while read -r name; do
  [[ "$name" =~ ^(nyc-[0-9a-f]{32}|nyabase-preflight-[0-9a-f]{32})$ ]] && candidates[$name]=1
done < <(incus list --format csv -c n 2>/dev/null)

for name in "${!candidates[@]}"; do
  owner="$(incus config get "$name" user.nyabase.server_id 2>/dev/null || true)"
  [[ -n "$owner" && -n "${owners[$owner]:-}" ]] || continue
  echo "delete instance $name"
  incus delete --force "$name" || rc=1
done

if [[ "$volumes_csv" != "-" ]]; then
  IFS=',' read -ra volumes <<<"$volumes_csv"
  for pair in "${volumes[@]}"; do
    pool="${pair%%/*}"; volume="${pair#*/}"
    [[ "$pool" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ && "$volume" =~ ^nyv-[0-9a-f]{32}$ ]] || continue
    incus storage volume show "$pool" "$volume" >/dev/null 2>&1 || continue
    echo "delete volume $pool/$volume"
    incus storage volume delete "$pool" "$volume" || rc=1
  done
fi

# The guard only drops IPv6 on nyabase veths; keep it while any other agent runs here.
others="$(systemctl list-units --type=service --state=active --no-legend --plain 'nyabase-*agent*' 2>/dev/null \
  | awk '{ print $1 }' | grep -v "^$agent_unit\.service$" || true)"
if [[ -z "$others" ]] && nft list table bridge nyabase_guard >/dev/null 2>&1; then
  echo "remove nft table bridge nyabase_guard"
  nft delete table bridge nyabase_guard || rc=1
fi
exit "$rc"
