#!/usr/bin/env bash
# Shared helpers for e2e.sh. Sourced, never executed.

log() { printf '[e2e] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

# Loads lab.env (or $E2E_LAB_ENV) and fills defaults.
load_lab() {
  local file="${E2E_LAB_ENV:-$E2E_DIR/lab.env}"
  [[ -f "$file" ]] || die "no lab inputs at $file: copy tests/e2e/lab.env.example to tests/e2e/lab.env and fill it in"
  set -a
  # shellcheck disable=SC1090
  source "$file"
  set +a
  E2E_RUN_ROOT="${E2E_RUN_ROOT:-${TMPDIR:-/var/tmp}/nyabase-e2e}"
  E2E_LISTEN_HOST="${E2E_LISTEN_HOST:-127.0.0.1}"
  export E2E_RUN_ROOT E2E_LISTEN_HOST
}

need() {
  local name
  for name in "$@"; do
    [[ -n "${!name:-}" ]] || die "$name is required in lab.env"
  done
}

need_tools() {
  local tool
  for tool in "$@"; do
    command -v "$tool" >/dev/null 2>&1 || die "required tool not found: $tool"
  done
}

# Sets RUN_ID, RUN_DIR and DB_NAME from $1 or the `current` pointer.
select_run() {
  RUN_ID="${1:-}"
  if [[ -z "$RUN_ID" && -f "$E2E_RUN_ROOT/current" ]]; then
    RUN_ID="$(<"$E2E_RUN_ROOT/current")"
  fi
  [[ "$RUN_ID" =~ ^[0-9]{14}-[0-9a-f]{4}$ ]] || return 1
  RUN_DIR="$E2E_RUN_ROOT/$RUN_ID"
  DB_NAME="nyabase_e2e_${RUN_ID//-/_}"
  return 0
}

# Admin connection (maintenance database) and the run's own database URL.
pg_admin() { psql "$E2E_PG_URL/postgres" -X -q -v ON_ERROR_STOP=1 "$@"; }
run_db_url() { printf '%s/%s' "$E2E_PG_URL" "$DB_NAME"; }

# Runs a bash script from stdin on a lab host (`local` = this machine).
# Arguments must be shell-safe words: they pass through the remote shell.
lab_bash() {
  local target="$1"
  shift
  if [[ "$target" == local ]]; then
    bash -s -- "$@"
  else
    ssh -o BatchMode=yes -o ConnectTimeout=10 "$target" bash -s -- "$@"
  fi
}

# True when $1 is a pid file of a process that belongs to this run.
run_owns_pid() {
  local pidfile="$1" pid
  [[ -f "$pidfile" ]] || return 1
  pid="$(<"$pidfile")"
  [[ "$pid" =~ ^[0-9]+$ && -r "/proc/$pid/environ" ]] || return 1
  tr '\0' '\n' <"/proc/$pid/environ" | grep -qx "E2E_RUN_ID=$RUN_ID"
}

stop_run_process() {
  local pidfile="$1" pid i
  run_owns_pid "$pidfile" || { rm -f "$pidfile"; return 0; }
  pid="$(<"$pidfile")"
  kill -TERM "$pid" 2>/dev/null || true
  for i in $(seq 1 30); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
  rm -f "$pidfile"
}
