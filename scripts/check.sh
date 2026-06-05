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

artifact="$(find packages/common/src -type f \( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -print -quit)"
if [[ -n "$artifact" ]]; then
  echo "Generated artifact found under packages/common/src: $artifact" >&2
  exit 1
fi

pnpm --filter @nyabase/common build
pnpm typecheck
pnpm lint
pnpm test:unit

if [[ "$with_visual" -eq 1 ]]; then
  bash scripts/check-visual.sh
fi
