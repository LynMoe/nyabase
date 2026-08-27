#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/common.sh"

usage() {
  printf '%s\n' \
    'usage:' \
    '  e2e.sh preflight' \
    '  e2e.sh doctor [run-id]' \
    '  e2e.sh build [run-id] [profile]' \
    '  e2e.sh provision <run-id>' \
    '  e2e.sh up [run-id] [profile]' \
    '  e2e.sh health <run-id>' \
    '  e2e.sh diagnose <run-id>' \
    '  e2e.sh run <profile> <run-id>' \
    '  e2e.sh down <run-id>' \
    '  e2e.sh release <run-id>'
}

command_name="${1:-}"
case "$command_name" in
  preflight)
    node "$SCRIPT_DIR/../coverage/validate.mjs"
    bash "$SCRIPT_DIR/doctor.sh" "${2:-}"
    ;;
  doctor)
    bash "$SCRIPT_DIR/doctor.sh" "${2:-}"
    ;;
  build)
    bash "$SCRIPT_DIR/build.sh" "${2:-}" "${3:-${E2E_PROFILE:-smoke}}"
    ;;
  provision)
    run_id="$(require_run_id "${2:-}")"
    bash "$SCRIPT_DIR/provision-incus.sh" apply "$run_id"
    ;;
  up)
    run_id="$(resolve_run_id "${2:-}")"
    bash "$SCRIPT_DIR/up.sh" "$run_id" "${3:-${E2E_PROFILE:-smoke}}"
    ;;
  health)
    bash "$SCRIPT_DIR/health.sh" "${2:-}"
    ;;
  diagnose)
    bash "$SCRIPT_DIR/diagnose.sh" "${2:-}"
    ;;
  run)
    bash "$SCRIPT_DIR/run.sh" "${2:-smoke}" "${3:-}"
    ;;
  down)
    bash "$SCRIPT_DIR/down.sh" "${2:-}"
    ;;
  release)
    bash "$SCRIPT_DIR/release.sh" "${2:-}"
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
