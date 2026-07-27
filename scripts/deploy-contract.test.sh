#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 0 ]]; then
  echo "Usage: bash scripts/deploy-contract.test.sh" >&2
  exit 2
fi

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "required command not found: $1" >&2
    exit 1
  }
}

require_command docker
require_command node

contract_root="$(mktemp -d)"
trap 'rm -rf "$contract_root"' EXIT
rendered="$contract_root/compose.json"

POSTGRES_PASSWORD=contract-test \
DATABASE_URL=postgresql://nyabase:contract-test@postgres:5432/nyabase \
REDIS_PASSWORD=contract-test \
REDIS_URL=redis://nyabase:contract-test@redis:6379/0 \
  docker compose -f deploy/docker-compose.yml config --format json >"$rendered"

node - "$rendered" <<'NODE'
const { readFileSync } = require('node:fs');
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const backend = config.services?.backend;
if (!backend) throw new Error('rendered Compose config has no backend service');
for (const serviceName of ['postgres', 'redis', 'victoriametrics', 'vmagent']) {
  const image = config.services?.[serviceName]?.image ?? '';
  if (!/^[^@\s]+@sha256:[0-9a-f]{64}$/.test(image)) {
    throw new Error(`${serviceName} image is not pinned by digest`);
  }
}
const redisCommand = (config.services?.redis?.command ?? []).join(' ');
for (const required of [
  '--user default off',
  '--user nyabase on',
  '+auth',
  '+ping',
  '+eval',
  '+hdel',
]) {
  if (!redisCommand.includes(required)) throw new Error(`Redis ACL is missing ${required}`);
}
for (const forbidden of ['+client', '+acl', '+config', '+shutdown', '+@all']) {
  if (redisCommand.split(/\s+/).includes(forbidden)) {
    throw new Error(`Redis ACL grants forbidden command/category ${forbidden}`);
  }
}
for (const serviceName of ['postgres', 'redis', 'victoriametrics', 'vmagent', 'backend']) {
  const service = config.services?.[serviceName];
  if (!(service?.cpus > 0) || !(service?.mem_limit > 0) || !(service?.pids_limit > 0)) {
    throw new Error(`${serviceName} resource limits are incomplete`);
  }
  if (service.stop_signal !== 'SIGTERM') {
    throw new Error(`${serviceName} does not use SIGTERM for graceful shutdown`);
  }
  if (service.logging?.driver !== 'json-file'
    || service.logging?.options?.['max-size'] !== '10m'
    || service.logging?.options?.['max-file'] !== '3') {
    throw new Error(`${serviceName} does not bound json-file logs`);
  }
}
for (const envName of [
  'PG_CONNECTION_TIMEOUT_MS',
  'PG_LOCK_TIMEOUT_MS',
  'PG_IDLE_IN_TRANSACTION_TIMEOUT_MS',
  'PG_READINESS_TIMEOUT_MS',
  'PG_SSL_MODE',
]) {
  if (!(envName in backend.environment)) throw new Error(`backend is missing ${envName}`);
}
if (backend.read_only !== true) throw new Error('backend root filesystem is not read-only');
if (!backend.cap_drop?.includes('ALL')) throw new Error('backend does not drop all capabilities');
if (!backend.security_opt?.some((entry) => entry.startsWith('no-new-privileges'))) {
  throw new Error('backend does not set no-new-privileges');
}
const tmpfs = Array.isArray(backend.tmpfs)
  ? backend.tmpfs
  : Object.entries(backend.tmpfs ?? {}).map(([path, options]) => `${path}:${options}`);
const tmp = tmpfs.find((entry) => entry.startsWith('/tmp:'));
for (const expected of ['rw', 'nosuid', 'nodev', 'noexec', 'uid=10001', 'gid=10001']) {
  if (!tmp?.includes(expected)) throw new Error(`backend /tmp tmpfs is missing ${expected}`);
}
NODE

grep -Eq '^FROM node:22-slim@sha256:[0-9a-f]{64} AS builder$' deploy/Dockerfile.backend
grep -Eq '^FROM node:22-slim@sha256:[0-9a-f]{64} AS runner$' deploy/Dockerfile.backend
grep -Eq '^USER 10001:10001$' deploy/Dockerfile.backend
grep -Eq 'disableClientInfo:[[:space:]]*true' packages/backend/src/runtime/redis-runtime.module.ts
grep -Eq 'image: postgres:18\.4-bookworm@sha256:[0-9a-f]{64}' .github/workflows/ci.yml
grep -Eq 'image: redis:8\.2-bookworm@sha256:[0-9a-f]{64}' .github/workflows/ci.yml
echo "deployment hardening contract tests passed"
