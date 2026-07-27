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

assert_no_common_src_artifacts
assert_no_backend_legacy_persistence
bash scripts/check-nest-sse-advisory.test.sh
bash scripts/check-nest-sse-advisory.sh
bash scripts/check-agent-task-conformance.sh
pnpm --filter @nyabase/e2e validate
pnpm --filter @nyabase/e2e test:evidence
bash scripts/check-rust-proxies.sh
pnpm build
node scripts/check-agent-embedded-helpers.mjs
node scripts/check-backend-bootstrap.mjs
assert_no_common_src_artifacts
assert_no_backend_legacy_persistence
bash scripts/check-nest-sse-advisory.sh
bash scripts/check-agent-task-conformance.sh
pnpm typecheck
pnpm lint
pnpm test:unit
