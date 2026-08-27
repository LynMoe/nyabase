#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 0 ]]; then
  echo "Usage: bash scripts/check.sh" >&2
  exit 2
fi

assert_no_common_src_artifacts() {
  local artifact
  artifact="$(find packages/common/src -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print -quit)"
  if [[ -n "$artifact" ]]; then
    echo "Generated artifact found under packages/common/src: $artifact" >&2
    exit 1
  fi
}

assert_no_backend_legacy_persistence() {
  if rg -n \
    "(@nestjs/typeorm|from ['\"]typeorm['\"]|[\"']typeorm[\"'][[:space:]]*:|better-sqlite3)" \
    packages/backend/src packages/backend/package.json; then
    echo "Backend still contains a TypeORM or better-sqlite3 dependency/path" >&2
    exit 1
  fi
}

assert_clean_cutover_architecture() {
  local required_path
  for required_path in \
    packages/backend/src/incus \
    packages/backend/src/runtime/intent.repository.ts \
    packages/backend/src/runtime/reconcile-worker.service.ts \
    packages/node-exporter/package.json \
    packages/node-exporter/src; do
    [[ -e "$required_path" ]] || {
      echo "clean-cutover architecture path is missing: $required_path" >&2
      exit 1
    }
  done

  has_source_entries() {
    [[ -e "$1" ]] || return 1
    [[ ! -d "$1" ]] && return 0
    rg --files "$1" | rg -q .
  }

  local retired_path
  for retired_path in \
    packages/agent \
    packages/backend/src/agent-tasks \
    packages/backend/src/gateway \
    packages/backend/src/datadirs \
    packages/backend/src/mount-sources \
    packages/backend/src/remote-fs \
    packages/backend/src/quota; do
    if has_source_entries "$retired_path"; then
      echo "retired control path still exists: $retired_path" >&2
      exit 1
    fi
  done

  rg -q 'Incus|incus' packages/backend/src/incus \
    || {
      echo "backend Incus client sources are missing" >&2
      exit 1
    }
  rg -q 'intent|reconcile' \
    packages/backend/src/runtime/intent.repository.ts \
    packages/backend/src/runtime/reconcile-worker.service.ts \
    || {
      echo "backend intent/reconciliation sources are missing" >&2
      exit 1
    }
  rg -q 'node' packages/node-exporter/src \
    || {
      echo "node-exporter sources are missing" >&2
      exit 1
    }
}

assert_no_common_src_artifacts
assert_no_backend_legacy_persistence
assert_clean_cutover_architecture
bash scripts/postgres-ops.test.sh
bash scripts/deploy-contract.test.sh
bash scripts/check-nest-sse-advisory.test.sh
bash scripts/check-nest-sse-advisory.sh
pnpm --filter @nyabase/e2e validate
pnpm --filter @nyabase/e2e test:evidence
bash scripts/check-rust-proxies.sh
pnpm build
node scripts/check-backend-bootstrap.mjs
assert_no_common_src_artifacts
assert_no_backend_legacy_persistence
bash scripts/check-nest-sse-advisory.sh
pnpm typecheck
pnpm lint
pnpm test:unit
