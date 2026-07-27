#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 0 ]]; then
  echo "Usage: bash scripts/check-nest-sse-advisory.sh" >&2
  exit 2
fi

scan_root="${NEST_SSE_SCAN_ROOT:-packages/backend/src}"
[[ -d "$scan_root" ]] || {
  echo "Nest SSE advisory scan root is not a directory: $scan_root" >&2
  exit 1
}
command -v rg >/dev/null 2>&1 || {
  echo "required command not found: rg" >&2
  exit 1
}

scan_pattern() {
  local description="$1"
  local pattern="$2"
  shift 2
  local output
  local status
  set +e
  output="$(
    rg --line-number --with-filename \
      --glob '*.ts' --glob '*.tsx' --glob '*.js' --glob '*.mjs' --glob '*.cjs' \
      "$@" "$pattern" "$scan_root"
  )"
  status="$?"
  set -e
  if [[ "$status" -eq 0 ]]; then
    printf '%s\n' "$output" >&2
    echo "Nest 10 SSE advisory gate rejected $description" >&2
    exit 1
  fi
  [[ "$status" -eq 1 ]] || {
    echo "Nest SSE advisory scan failed while checking $description" >&2
    exit 1
  }
}

# Catch direct decorators, namespace access and import aliasing (`Sse as X`);
# the word boundary intentionally applies to source/comments alike so an
# advisory bypass cannot be hidden behind a local alias.
scan_pattern \
  'the Nest Sse decorator/API or SseStream type' \
  '(^|[^[:alnum:]_$])Sse(Stream)?([^[:alnum:]_$]|$)'
scan_pattern \
  'an SSE HTTP response surface' \
  'text[[:space:]]*/[[:space:]]*event-stream' \
  --ignore-case

echo "Nest 10 SSE advisory source gate passed"
