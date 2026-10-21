#!/usr/bin/env bash
# Runs ON a lab host (piped to `bash -s` by e2e.sh down). Removes only what one
# e2e run created there:
#   * instances whose Incus config user.nyabase.server_id is one of this run's
#     server ids (production labels every managed instance and preflight probe
#     with it), looked up among the instance names the run's DB recorded plus
#     every nyc-* / nyabase-preflight-* instance currently on the host;
#   * custom volumes named exactly as the run's DB recorded them;
#   * the trust entry with the run's Incus client certificate fingerprint, and
#     the run's still-unused one-time trust token.
# Anything else on the host is left alone.
# Args: <server ids, comma separated> <client fingerprint or -> <trust token name>
#       <instances, comma separated or -> <pool/volume pairs, comma separated or ->
set -uo pipefail
sids_csv="$1"; fingerprint="$2"; token_name="$3"; instances_csv="$4"; volumes_csv="$5"
rc=0

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

if [[ "$fingerprint" =~ ^[0-9a-f]{64}$ ]] && incus config trust show "$fingerprint" >/dev/null 2>&1; then
  echo "remove trust entry $fingerprint"
  incus config trust remove "$fingerprint" || rc=1
fi
incus config trust revoke-token "$token_name" >/dev/null 2>&1 || true
exit "$rc"
