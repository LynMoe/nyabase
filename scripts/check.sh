#!/usr/bin/env bash
set -euo pipefail

with_visual=0
for arg in "$@"; do
  case "$arg" in
    --with-visual)
      with_visual=1
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

assert_no_common_src_artifacts() {
  local artifact
  artifact="$(find packages/common/src -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print -quit)"
  if [[ -n "$artifact" ]]; then
    echo "Generated artifact found under packages/common/src: $artifact" >&2
    exit 1
  fi
}

assert_no_common_src_artifacts
bash scripts/check-agent-task-conformance.sh
pnpm build
assert_no_common_src_artifacts
bash scripts/check-agent-task-conformance.sh
pnpm typecheck
pnpm lint
pnpm test:unit

if [[ "$with_visual" -eq 1 ]]; then
  bash scripts/check-visual.sh
fi
