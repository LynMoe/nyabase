#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 0 ]]; then
  echo "Usage: bash scripts/check-nest-sse-advisory.test.sh" >&2
  exit 2
fi

test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT
fixture="$test_root/fixture.ts"
gate="scripts/check-nest-sse-advisory.sh"

printf '%s\n' "export const contentType = 'application/json';" >"$fixture"
NEST_SSE_SCAN_ROOT="$test_root" bash "$gate" >/dev/null

expect_rejected() {
  local label="$1"
  local source="$2"
  printf '%s\n' "$source" >"$fixture"
  if NEST_SSE_SCAN_ROOT="$test_root" bash "$gate" >/dev/null 2>&1; then
    echo "Nest SSE advisory gate missed: $label" >&2
    exit 1
  fi
}

expect_rejected 'direct decorator' \
  "class EventsController { @Sse('events') events() {} }"
expect_rejected 'aliased import' \
  "import { Sse as StreamEndpoint } from '@nestjs/common';"
expect_rejected 'namespace API access' \
  "const streamDecorator = NestCommon.Sse;"
expect_rejected 'SseStream construction' \
  "const stream = new SseStream(request);"
expect_rejected 'SSE response content type' \
  "response.setHeader('Content-Type', 'text/event-stream');"

echo "Nest 10 SSE advisory gate self-tests passed"
