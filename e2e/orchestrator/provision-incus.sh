#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/common.sh"

HOST_FORWARD_USER_CHAIN="$(printf '%s%s' 'DOCK' 'ER-USER')"

usage() {
  printf '%s\n' \
    'usage:' \
    '  provision-incus.sh apply <run-id>' \
    '  provision-incus.sh ensure-lvm <run-id>' \
    '  provision-incus.sh cleanup <run-id>'
}

read_owned_value() {
  local path="$1"
  local key="$2"
  awk -F= -v key="$key" '$1 == key { print substr($0, length(key) + 2); exit }' "$path"
}

valid_ipv4() {
  local value="$1"
  local octet
  local -a parts=()
  IFS=. read -r -a parts <<<"$value"
  [[ "${#parts[@]}" -eq 4 ]] || return 1
  for octet in "${parts[@]}"; do
    [[ "$octet" =~ ^[0-9]{1,3}$ ]] || return 1
    ((octet <= 255)) || return 1
  done
}

valid_cidr() {
  local value="$1"
  local address prefix
  [[ "$value" == */* ]] || return 1
  address="${value%/*}"
  prefix="${value#*/}"
  valid_ipv4 "$address" || return 1
  [[ "$prefix" =~ ^[0-9]{1,2}$ ]] && ((prefix <= 32))
}

validate_network_inputs() {
  local parent="${E2E_INCUS_PARENT_INTERFACE:-}"
  [[ "$parent" =~ ^[A-Za-z0-9_.-]{1,15}$ ]] \
    || die "E2E_INCUS_PARENT_INTERFACE is not a valid Linux interface name"
  valid_cidr "${E2E_INCUS_ROUTED_SUBNET:-}" \
    || die "E2E_INCUS_ROUTED_SUBNET must be an IPv4 CIDR"
  for name in E2E_INCUS_ROUTED_ADDRESS E2E_INCUS_SPOOF_ADDRESS \
    E2E_INCUS_ROUTED_GATEWAY E2E_INCUS_PROBE_ADDRESS; do
    valid_ipv4 "${!name:-}" || die "$name must be an IPv4 address"
  done
  ip link show "$parent" >/dev/null 2>&1 \
    || die "macvlan parent interface does not exist: $parent"
}

write_ownership() {
  local path="$1" run_id="$2" table="$3" parent="$4" subnet="$5" probe="$6" state="$7"
  local filter_chain="${8:-}" filter_jump_handle="${9:-}"
  local temporary="${path}.$$"
  umask 077
  {
    printf 'run_id=%s\n' "$run_id"
    printf 'state=%s\n' "$state"
    printf 'mode=macvlan\n'
    printf 'nft_table=%s\n' "$table"
    printf 'parent_interface=%s\n' "$parent"
    printf 'routed_subnet=%s\n' "$subnet"
    printf 'probe_address=%s\n' "$probe"
    printf 'filter_chain=%s\n' "$filter_chain"
    printf 'filter_jump_handle=%s\n' "$filter_jump_handle"
  } >"$temporary"
  chmod 0600 "$temporary"
  mv -f "$temporary" "$path"
}

write_sysctl_before() {
  local path="$1" run_id="$2" parent="$3"
  local temporary="${path}.$$"
  umask 077
  {
    printf 'run_id=%s\n' "$run_id"
    printf 'ip_forward=%s\n' "$(sysctl -n net.ipv4.ip_forward)"
    printf 'parent_forwarding=%s\n' "$(sysctl -n "net.ipv4.conf.${parent}.forwarding")"
    printf 'parent_rp_filter=%s\n' "$(sysctl -n "net.ipv4.conf.${parent}.rp_filter")"
  } >"$temporary"
  chmod 0600 "$temporary"
  mv -f "$temporary" "$path"
}

# Phase-0 residual: loop/LVM volumes may carry activation-skip so root LVs do not
# activate and Incus start fails with missing templates. Clear skip on the e2e
# pool VG only (never touch unrelated VGs). Safe to re-run.
ensure_lvm_activation_skip() {
  local run_id="$1"
  local pool="${E2E_INCUS_LVM_POOL:-}"
  local runtime_dir proof pool_info driver vg_name lv_name skip_flag cleared=0 activated=0
  local -a cleared_lvs=()

  require_command incus
  require_command lvs
  require_command lvchange
  require_env E2E_INCUS_LVM_POOL
  [[ "$pool" =~ ^[A-Za-z0-9_.:@/-]+$ ]] \
    || die "E2E_INCUS_LVM_POOL is not a safe Incus storage name"

  runtime_dir="$(runtime_dir_for "$run_id")"
  install -d -m 0700 "$runtime_dir"
  proof="$runtime_dir/lvm-activation-skip-proof"
  pool_info="$(incus storage show "$pool" 2>/dev/null || true)"
  [[ -n "$pool_info" ]] || die "Incus LVM pool is missing: $pool"
  driver="$(awk -F': *' '$1 == "driver" { print $2; exit }' <<<"$pool_info")"
  [[ "$driver" == "lvm" ]] || die "storage pool $pool is not LVM-backed (driver=$driver)"
  vg_name="$(incus storage get "$pool" lvm.vg_name 2>/dev/null || true)"
  [[ -n "$vg_name" && "$vg_name" =~ ^[A-Za-z0-9_.:-]+$ ]] \
    || die "could not resolve a safe lvm.vg_name for $pool"
  vgs "$vg_name" >/dev/null 2>&1 \
    || die "LVM volume group for e2e pool is missing: $vg_name"

  while IFS=$'\t' read -r lv_name skip_flag; do
    [[ -n "$lv_name" ]] || continue
    # Skip thin-pool infrastructure; only volume LVs need the phase-0 clear.
    [[ "$lv_name" == IncusThinPool || "$lv_name" == *ThinPool* || "$lv_name" == lvol*_pmspare ]] \
      && continue
    [[ "$lv_name" == *"_tdata" || "$lv_name" == *"_tmeta" || "$lv_name" == *"_pmspare" ]] \
      && continue
    if [[ "$skip_flag" == "y" || "$skip_flag" == "yes" || "$skip_flag" == "1" ]]; then
      lvchange --setactivationskip n "$vg_name/$lv_name" >/dev/null \
        || die "failed to clear activation-skip on $vg_name/$lv_name"
      cleared_lvs+=("$lv_name")
      cleared=$((cleared + 1))
    fi
    # Prove the LV can be activated with the phase-0 ignore path, then leave
    # activation state alone if already active; deactivate only if we activated.
    if ! lvs -o lv_active --noheadings "$vg_name/$lv_name" 2>/dev/null | rg -q 'active'; then
      if lvchange -ay --ignoreactivationskip "$vg_name/$lv_name" >/dev/null 2>&1; then
        activated=$((activated + 1))
        lvchange -an --ignoreactivationskip "$vg_name/$lv_name" >/dev/null 2>&1 || true
      fi
    fi
  done < <(
    lvs -o lv_name,skip_activation --noheadings --separator=$'\t' "$vg_name" 2>/dev/null \
      | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
  )

  {
    printf 'run_id=%s\n' "$run_id"
    printf 'pool=%s\n' "$pool"
    printf 'vg=%s\n' "$vg_name"
    printf 'cleared_count=%s\n' "$cleared"
    printf 'activated_probe_count=%s\n' "$activated"
    printf 'cleared_lvs=%s\n' "${cleared_lvs[*]}"
    printf 'phase0_cite=phase-0-report.md residual activation-skip\n'
    printf 'state=ready\n'
  } >"${proof}.$$"
  chmod 0600 "${proof}.$$"
  mv -f "${proof}.$$" "$proof"
  log "LVM activation-skip workaround applied for $pool (vg=$vg_name cleared=$cleared)"
}

delete_owned_tables() {
  local family table="$1"
  for family in inet ip; do
    nft delete table "$family" "$table" >/dev/null 2>&1 || true
  done
}

filter_jump_handles() {
  local chain="$1"
  nft -nn -a list chain ip filter "$HOST_FORWARD_USER_CHAIN" 2>/dev/null \
    | awk -v target="$chain" '
        index($0, "jump " target " ") {
          for (i = 1; i <= NF; i++) {
            if ($i == "handle") {
              print $(i + 1)
              break
            }
          }
        }
      '
}

delete_owned_filter() {
  local chain="${1:-}"
  local handles handle
  [[ -n "$chain" ]] || return 0

  handles="$(filter_jump_handles "$chain" || true)"
  while IFS= read -r handle; do
    [[ "$handle" =~ ^[0-9]+$ ]] \
      || continue
    nft delete rule ip filter "$HOST_FORWARD_USER_CHAIN" handle "$handle" \
      >/dev/null 2>&1 \
      || die "failed to remove run-owned host forwarding jump"
  done <<<"$handles"

  if [[ -n "$(filter_jump_handles "$chain" || true)" ]]; then
    die "run-owned host forwarding jump remains after cleanup"
  fi
  if nft list chain ip filter "$chain" >/dev/null 2>&1; then
    nft delete chain ip filter "$chain" >/dev/null \
      || die "failed to remove run-owned host forwarding chain"
  fi
}

install_filter_bridge() {
  local chain="$1" parent="$2" subnet="$3" probe="$4"
  local handles
  nft list chain ip filter "$HOST_FORWARD_USER_CHAIN" >/dev/null 2>&1 \
    || die "host forwarding user chain is unavailable for run-owned egress policy"
  nft add chain ip filter "$chain"
  nft add rule ip filter "$chain" \
    ip saddr "$subnet" oifname "$parent" accept
  nft add rule ip filter "$chain" \
    ip saddr "$probe/32" oifname "$parent" accept
  # NEW inbound from the physical LAN parent (required when host FORWARD policy is DROP).
  nft add rule ip filter "$chain" \
    ip daddr "$subnet" iifname "$parent" accept
  nft add rule ip filter "$chain" \
    ip daddr "$probe/32" iifname "$parent" accept
  nft add rule ip filter "$chain" \
    fib saddr . iif oif missing drop
  nft add rule ip filter "$chain" \
    ct state established,related ip daddr "$subnet" iifname "$parent" accept
  nft add rule ip filter "$chain" \
    ct state established,related ip daddr "$probe/32" iifname "$parent" accept
  nft insert rule ip filter "$HOST_FORWARD_USER_CHAIN" jump "$chain"
  handles="$(filter_jump_handles "$chain" || true)"
  [[ "$handles" =~ ^[0-9]+$ ]] \
    || die "run-owned host forwarding jump was not created exactly once"
  printf '%s\n' "$handles"
}

cleanup_network() {
  local run_id="$1"
  local runtime_dir ownership sysctl_before table parent state filter_chain
  runtime_dir="$(runtime_dir_for "$run_id")"
  ownership="$runtime_dir/network-ownership"
  sysctl_before="$runtime_dir/network-sysctl-before"
  table="$(nft_table_for_run "$run_id")"

  if [[ ! -e "$ownership" && ! -e "$sysctl_before" ]]; then
    if nft list table inet "$table" >/dev/null 2>&1 \
      || nft list table ip "$table" >/dev/null 2>&1; then
      die "run-owned network table exists without ownership metadata: $table"
    fi
    return 0
  fi
  [[ -f "$ownership" && ! -L "$ownership" ]] \
    || die "network ownership metadata is missing or unsafe"
  local owner_run_id
  owner_run_id="$(read_owned_value "$ownership" run_id)"
  if [[ -z "$owner_run_id" ]]; then
    [[ "$(read_owned_value "$ownership" parent_interface)" == "${E2E_INCUS_PARENT_INTERFACE:-eth0}" ]] \
      || die "legacy network ownership metadata does not match the configured parent"
    [[ "$(read_owned_value "$ownership" routed_subnet)" == "${E2E_INCUS_ROUTED_SUBNET:-}" ]] \
      || die "legacy network ownership metadata does not match the configured subnet"
    [[ "$(read_owned_value "$ownership" probe_address)" == "${E2E_INCUS_PROBE_ADDRESS:-}" ]] \
      || die "legacy network ownership metadata does not match the configured probe"
  else
    [[ "$owner_run_id" == "$run_id" ]] \
      || die "network ownership metadata belongs to another run"
  fi
  [[ "$(read_owned_value "$ownership" nft_table)" == "$table" ]] \
    || die "network ownership table does not match the run"
  state="$(read_owned_value "$ownership" state)"
  [[ -n "$state" ]] || state=active
  [[ "$state" == active || "$state" == cleaned ]] \
    || die "network ownership metadata has an invalid state"
  filter_chain="$(read_owned_value "$ownership" filter_chain)"
  [[ -z "$filter_chain" || "$filter_chain" == "$table" ]] \
    || die "network ownership filter chain does not match the run"

  delete_owned_filter "$filter_chain"
  delete_owned_tables "$table"
  if [[ "$state" == active ]]; then
    local mode
    mode="$(read_owned_value "$ownership" mode)"
    # macvlan provision does not mutate host forwarding sysctls.
    if [[ "$mode" != macvlan ]]; then
      local parent before_ip before_parent before_rp current_ip current_parent current_rp
      parent="$(read_owned_value "$ownership" parent_interface)"
      if [[ -f "$sysctl_before" && ! -L "$sysctl_before" ]]; then
        [[ "$(read_owned_value "$sysctl_before" run_id)" == "$run_id" ]] \
          || die "network sysctl ownership metadata belongs to another run"
        before_ip="$(read_owned_value "$sysctl_before" ip_forward)"
        before_parent="$(read_owned_value "$sysctl_before" parent_forwarding)"
        before_rp="$(read_owned_value "$sysctl_before" parent_rp_filter)"
      else
        [[ -f "$runtime_dir/sysctl-ip-forward-before" \
          && -f "$runtime_dir/sysctl-${parent}-forwarding-before" ]] \
          || die "network sysctl ownership metadata is missing"
        before_ip="$(<"$runtime_dir/sysctl-ip-forward-before")"
        before_parent="$(<"$runtime_dir/sysctl-${parent}-forwarding-before")"
        before_rp=""
      fi
      current_ip="$(sysctl -n net.ipv4.ip_forward)"
      current_parent="$(sysctl -n "net.ipv4.conf.${parent}.forwarding")"
      current_rp="$(sysctl -n "net.ipv4.conf.${parent}.rp_filter")"
      [[ "$current_ip" == "1" && "$current_parent" == "1" ]] \
        || die "refusing to restore sysctls changed by another owner"
      [[ "$before_ip" =~ ^[0-9]+$ && "$before_parent" =~ ^[0-9]+$ ]] \
        || die "network sysctl baseline is malformed"
      sysctl -w "net.ipv4.ip_forward=$before_ip" >/dev/null
      sysctl -w "net.ipv4.conf.${parent}.forwarding=$before_parent" >/dev/null
      if [[ "$before_rp" == "0" && "$current_rp" == "1" ]]; then
        sysctl -w "net.ipv4.conf.${parent}.rp_filter=$before_rp" >/dev/null
      fi
    fi
    write_ownership "$ownership" "$run_id" "$table" \
      "$(read_owned_value "$ownership" parent_interface)" \
      "$(read_owned_value "$ownership" routed_subnet)" \
      "$(read_owned_value "$ownership" probe_address)" cleaned \
      "$filter_chain" ""
  fi
  printf 'network_cleanup=passed\nrun_id=%s\nnft_table=%s\nfilter_chain=%s\nmode=macvlan\n' \
    "$run_id" "$table" "$filter_chain" >"$runtime_dir/network-cleanup-proof"
  chmod 0600 "$runtime_dir/network-cleanup-proof"
}

apply_network() {
  local run_id="$1"
  local runtime_dir ownership sysctl_before table parent subnet probe
  runtime_dir="$(runtime_dir_for "$run_id")"
  ownership="$runtime_dir/network-ownership"
  sysctl_before="$runtime_dir/network-sysctl-before"
  table="$(nft_table_for_run "$run_id")"
  parent="$E2E_INCUS_PARENT_INTERFACE"
  subnet="$E2E_INCUS_ROUTED_SUBNET"
  probe="$E2E_INCUS_PROBE_ADDRESS"
  install -d -m 0700 "$runtime_dir"

  if [[ -f "$ownership" && ! -L "$ownership" ]]; then
    [[ "$(read_owned_value "$ownership" run_id)" == "$run_id" ]] \
      || die "network ownership metadata belongs to another run"
    [[ "$(read_owned_value "$ownership" state)" == active ]] \
      || die "run-owned network has already been cleaned; use a fresh run id"
    [[ "$(read_owned_value "$ownership" nft_table)" == "$table" ]] \
      || die "network ownership table does not match the run"
  elif [[ -e "$ownership" || -e "$sysctl_before" ]]; then
    die "network ownership metadata is not a safe regular file"
  fi

  # macvlan attaches to the LAN parent directly. Do not install routed FIB/SNAT
  # rules against the real LAN CIDR (that would hijack host LAN forwarding).
  if nft list chain ip filter "$table" >/dev/null 2>&1; then
    delete_owned_filter "$table"
  fi
  if nft list table inet "$table" >/dev/null 2>&1 \
    || nft list table ip "$table" >/dev/null 2>&1; then
    delete_owned_tables "$table"
  fi

  if [[ ! -f "$sysctl_before" ]]; then
    write_sysctl_before "$sysctl_before" "$run_id" "$parent"
  fi

  write_ownership "$ownership" "$run_id" "$table" "$parent" "$subnet" "$probe" \
    active "" ""
  printf 'mode=macvlan\nnft_table=%s\nrouted_subnet=%s\nprobe_address=%s\nparent_interface=%s\n' \
    "$table" "$subnet" "$probe" "$parent" >"$runtime_dir/nft-table"
  chmod 0600 "$runtime_dir/nft-table"
  printf 'macvlan parent=%s subnet=%s probe=%s\n' "$parent" "$subnet" "$probe" \
    >"$runtime_dir/nft-proof"
  chmod 0600 "$runtime_dir/nft-proof"
}

action="${1:-}"
run_id="$(require_run_id "${2:-}")"
case "$action" in
  apply)
    for command in nft ip sysctl; do
      require_command "$command"
    done
    require_env E2E_INCUS_PARENT_INTERFACE
    require_env E2E_INCUS_ROUTED_SUBNET
    require_env E2E_INCUS_ROUTED_ADDRESS
    require_env E2E_INCUS_SPOOF_ADDRESS
    require_env E2E_INCUS_ROUTED_GATEWAY
    require_env E2E_INCUS_PROBE_ADDRESS
    validate_network_inputs
    apply_network "$run_id"
    if [[ -n "${E2E_INCUS_LVM_POOL:-}" ]]; then
      ensure_lvm_activation_skip "$run_id"
    fi
    log "Incus macvlan LAN network provisioned for $run_id"
    ;;
  ensure-lvm)
    ensure_lvm_activation_skip "$run_id"
    ;;
  cleanup)
    require_command nft
    cleanup_network "$run_id"
    log "Incus macvlan LAN network cleaned for $run_id"
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
