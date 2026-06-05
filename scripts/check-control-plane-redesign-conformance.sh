#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail=0
report_fail() {
  printf 'FAIL %s\n' "$1" >&2
  fail=1
}
report_pass() {
  printf 'PASS %s\n' "$1"
}

search_src() {
  local pattern="$1"
  shift
  grep -R --line-number --fixed-strings "$pattern" "$@" 2>/dev/null || true
}

assert_absent() {
  local label="$1"
  local pattern="$2"
  shift 2
  local matches
  matches="$(search_src "$pattern" "$@")"
  if [[ -n "$matches" ]]; then
    report_fail "$label: found forbidden pattern '$pattern'"
    printf '%s\n' "$matches" >&2
  else
    report_pass "$label"
  fi
}

assert_file_absent() {
  local label="$1"
  local path="$2"
  if [[ -e "$path" ]]; then
    report_fail "$label: forbidden file still exists: $path"
  else
    report_pass "$label"
  fi
}

assert_file_present() {
  local label="$1"
  local path="$2"
  if [[ -e "$path" ]]; then
    report_pass "$label"
  else
    report_fail "$label: required file missing: $path"
  fi
}

# Old public container identity/routes must be gone.
assert_absent "old route params removed" ':serverId/:containerId' packages/backend/src packages/frontend/src packages/common/src test/specs test/scripts
assert_absent "old frontend route removed" '$serverId.$containerId' packages/frontend/src packages/frontend/e2e
assert_file_absent "old TanStack serverId+containerId route file removed" 'packages/frontend/src/routes/containers/$serverId.$containerId.tsx'

# Old agent command names must be gone from source and tests.
assert_absent "old applySpec command removed" 'container.applySpec' packages/common/src packages/backend/src packages/agent/src test/specs test/scripts
assert_absent "old setPower command removed" 'container.setPower' packages/common/src packages/backend/src packages/agent/src test/specs test/scripts
assert_absent "old applyMounts command removed" 'container.applyMounts' packages/common/src packages/backend/src packages/agent/src test/specs test/scripts
assert_absent "old reconcileSsh command removed" 'container.reconcileSsh' packages/common/src packages/backend/src packages/agent/src test/specs test/scripts
assert_absent "legacy label constants removed" 'LEGACY_LABEL' packages/common/src packages/backend/src packages/agent/src test/specs test/scripts
assert_absent "legacy spec version removed" 'LEGACY_SPEC_VERSION' packages/common/src packages/backend/src packages/agent/src test/specs test/scripts
assert_absent "legacy desired import id removed" 'legacy-' packages/backend/src packages/agent/src packages/common/src test/specs

# Hidden old container chain must be removed, not kept as fallback.
assert_file_absent "old container read model service removed" packages/backend/src/containers/container-read-model.service.ts
assert_file_absent "old container mounts command-coupling service removed" packages/backend/src/containers/container-mounts.service.ts
assert_file_absent "old container ssh sync hook service removed" packages/backend/src/containers/container-ssh-sync.service.ts
assert_absent "old direct start method removed" 'startContainer(' packages/backend/src/containers packages/backend/src/operations packages/frontend/src test/specs test/scripts
assert_absent "old direct stop method removed" 'stopContainer(' packages/backend/src/containers packages/backend/src/operations packages/frontend/src test/specs test/scripts
assert_absent "old direct restart method removed" 'restartContainer(' packages/backend/src/containers packages/backend/src/operations packages/frontend/src test/specs test/scripts
assert_absent "old direct delete method removed" 'deleteContainer(' packages/backend/src/containers packages/backend/src/operations packages/frontend/src test/specs test/scripts
assert_absent "old transient docker id resolver removed" 'resolveDockerIdForTransientContainerCommand' packages/backend/src packages/frontend/src test/specs test/scripts
assert_absent "old list visibility wait helper removed" 'waitForContainerByName' test/specs test/scripts
assert_absent "old REST container API path removed from frontend/tests" "'/containers" test/specs test/scripts
assert_absent "old double-quoted REST container API path removed from frontend/tests" '"/containers' test/specs test/scripts
assert_absent "old template REST container API path removed from frontend/tests" '`/containers' test/specs test/scripts
assert_absent "frontend/test Docker ID identity inference removed" 'spec.dockerId' test/specs test/scripts
assert_absent "frontend lifecycle docker binding inference removed" 'lifecycle?.dockerId' test/specs test/scripts


assert_absent "backend ContainerEntity docker id query removed" 'where: { serverId, dockerId' packages/backend/src
assert_absent "backend ContainerEntity sshEnabled query removed" 'where: { ownerId: userId, sshEnabled' packages/backend/src
assert_absent "public/test spec docker id removed" 'spec.dockerId' packages/common/src packages/frontend/src test/specs test/scripts
assert_absent "frontend metrics docker id removed" 'c.dockerId' packages/frontend/src
assert_absent "old direct delete route usage removed" "'DELETE', containerPath" test/specs test/scripts
assert_absent "old direct delete routePath usage removed" "'DELETE', routePath" test/specs test/scripts
assert_absent "old exec endpoint suffix removed" "'/exec'" test/specs test/scripts packages/frontend/src
assert_absent "old mounts endpoint suffix removed" "'/mounts'" test/specs test/scripts packages/frontend/src

# New V2 contract files/services must exist after implementation.
assert_file_present "container action policy service exists" packages/backend/src/containers/container-action-policy.service.ts
assert_file_present "container control service exists" packages/backend/src/containers/container-control.service.ts
assert_file_present "container operation service exists" packages/backend/src/containers/container-operation.service.ts
assert_file_absent "old runtime observation service removed" packages/backend/src/runtime/runtime-observation.service.ts
assert_file_present "runtime orphan service exists" packages/backend/src/runtime/runtime-orphan.service.ts
assert_file_present "frontend operation tracker exists" packages/frontend/src/hooks/use-operation-tracker.ts

# No generated common-source artifacts.
common_artifacts="$(find packages/common/src \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print | sort)"
if [[ -n "$common_artifacts" ]]; then
  report_fail "common source artifact guard"
  printf '%s\n' "$common_artifacts" >&2
else
  report_pass "common source artifact guard"
fi

if [[ "$fail" != 0 ]]; then
  printf '\nControl-plane redesign conformance check failed. This is expected before the incompatible refactor is implemented.\n' >&2
  exit 1
fi

printf '\nControl-plane redesign conformance check passed.\n'
