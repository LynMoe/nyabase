#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command="${1:-}"
shift || true

case "$command" in
  preflight|doctor|build|certs|up|health|diagnose|down)
    exec "$here/${command}.sh" "$@"
    ;;
  run)
    exec "$here/run.sh" "$@"
    ;;
  release)
    exec "$here/run-full-release.sh" "$@"
    ;;
  *)
    printf 'usage: %s preflight {smoke|core|full|recovery}\n' "$0" >&2
    printf '       %s {doctor|build|certs|up|health|diagnose|down} [runId]\n' "$0" >&2
    printf '       %s run {smoke|core|full|recovery} [runId]\n' "$0" >&2
    printf '       %s release [baseRunId]\n' "$0" >&2
    exit 2
    ;;
esac
