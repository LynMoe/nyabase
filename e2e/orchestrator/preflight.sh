#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

profile="${1:-smoke}"
case "$profile" in
  smoke|core|full|recovery) ;;
  *) die "unknown CPU E2E profile: $profile" ;;
esac

# Loading the Playwright config validates the profile schema, provider
# descriptor, and every required topology capability. Runtime inputs are
# intentionally waived here because this gate runs before a run directory,
# certificate, secret, image, container, network, or volume may be created.
E2E_PROFILE="$profile" E2E_ALLOW_MISSING_RUNTIME=1 \
  pnpm --dir "$E2E_ROOT" --filter @nyabase/e2e exec playwright test --list \
  >/dev/null

log "preflight PASS: profile=$profile is supported by the selected CPU topology"
