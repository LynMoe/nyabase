#!/usr/bin/env bash
set -euo pipefail

pnpm --filter @nyabase/frontend exec playwright test
