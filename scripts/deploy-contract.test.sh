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

for obsolete_path in \
  deploy/install-agent.sh \
  deploy/agent.systemd.service \
  deploy/agent.example.yaml \
  scripts/build-agent-binary.sh \
  scripts/check-agent-task-conformance.sh \
  scripts/check-agent-embedded-helpers.mjs; do
  if [[ -e "$obsolete_path" ]]; then
    echo "obsolete clean-cutover path still exists: $obsolete_path" >&2
    exit 1
  fi
done

contract_root="$(mktemp -d)"
trap 'rm -rf "$contract_root"' EXIT
rendered="$contract_root/compose.json"
POSTGRES_PASSWORD=contract-test-superuser \
NYABASE_DB_PASSWORD=contract-test \
DATABASE_URL=postgresql://nyabase:contract-test@postgres:5432/nyabase \
  docker compose -f deploy/docker-compose.yml config --format json >"$rendered"

node - "$rendered" <<'NODE'
const { readFileSync } = require('node:fs');
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const backend = config.services?.backend;
if (!backend) throw new Error('rendered Compose config has no backend service');
const serviceNames = Object.keys(config.services ?? {}).sort();
const expectedServices = ['backend', 'postgres', 'victoriametrics'];
if (JSON.stringify(serviceNames) !== JSON.stringify(expectedServices)) {
  throw new Error(
    `Compose services must be exactly ${expectedServices.join(', ')}, got ${serviceNames.join(', ')}`,
  );
}
// Bind-mount sources render as absolute paths; the checkout's own location
// (a worktree named agent-…, say) is not part of the deployment.
const renderedText = JSON.stringify(config).split(process.cwd()).join('<checkout>');
for (const forbidden of [
  'backend-gateway',
  'NYABASE_RUNTIME_ROLE',
  'NYABASE_CONSOLE_PUBLIC_URL',
  'dockerd',
  'dockerRoot',
  'macvlan',
  'remote-fs',
  'data-dir',
  'workflow',
  'agent-task',
]) {
  if (renderedText.toLowerCase().includes(forbidden.toLowerCase())) {
    throw new Error(`Compose still contains obsolete runtime path: ${forbidden}`);
  }
}
if (/(^|[^a-z0-9_])agent([^a-z0-9_]|$)/i.test(renderedText)) {
  throw new Error('Compose still contains the retired host control process');
}
for (const serviceName of ['postgres', 'victoriametrics']) {
  const image = config.services?.[serviceName]?.image ?? '';
  if (!/^[^@\s]+@sha256:[0-9a-f]{64}$/.test(image)) {
    throw new Error(`${serviceName} image is not pinned by digest`);
  }
}
for (const serviceName of ['postgres', 'victoriametrics', 'backend']) {
  const service = config.services?.[serviceName];
  if (!(service?.cpus > 0) || !(service?.mem_limit > 0) || !(service?.pids_limit > 0)) {
    throw new Error(`${serviceName} resource limits are incomplete`);
  }
  // Docker rejects a CPU limit above the host's CPU count: the defaults must
  // start on a two-CPU host.
  if (service.cpus > 2) {
    throw new Error(`${serviceName} default CPU limit ${service.cpus} exceeds a two-CPU host`);
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
  'INCUS_PREFLIGHT_IMAGE_ALIAS',
  'INCUS_PREFLIGHT_EGRESS_URL',
  'INCUS_REQUEST_TIMEOUT_MS',
  'INCUS_OPERATION_WAIT_TIMEOUT_MS',
]) {
  if (!(envName in backend.environment)) throw new Error(`backend is missing ${envName}`);
}
// The Backend connects as the database owner `nyabase`, never as the cluster
// superuser, whose password stays with the postgres service.
const postgres = config.services.postgres;
if (postgres.environment?.POSTGRES_USER !== 'postgres') {
  throw new Error('the PostgreSQL superuser must be `postgres`, separate from the Backend role');
}
if (!postgres.environment?.NYABASE_DB_PASSWORD) {
  throw new Error('postgres must receive NYABASE_DB_PASSWORD to create the Backend role');
}
if (!(postgres.volumes ?? []).some((volume) => volume.type === 'bind'
  && volume.source.endsWith('/deploy/postgres-app-role.sh')
  && volume.target.startsWith('/docker-entrypoint-initdb.d/')
  && volume.read_only === true)) {
  throw new Error('postgres does not mount postgres-app-role.sh as a read-only init script');
}
for (const name of ['POSTGRES_PASSWORD', 'POSTGRES_USER', 'NYABASE_DB_PASSWORD']) {
  if (name in backend.environment) throw new Error(`backend must not receive ${name}`);
}
// Host agents dial the Backend; it holds no Incus TLS material.
if ('INCUS_CA_FILE' in backend.environment || backend.secrets?.length || config.secrets) {
  throw new Error('backend must not be given Incus TLS secrets');
}
for (const serviceName of ['backend', 'victoriametrics']) {
  const service = config.services[serviceName];
  if (service.read_only !== true) throw new Error(`${serviceName} root filesystem is not read-only`);
  if (!service.cap_drop?.includes('ALL')) throw new Error(`${serviceName} does not drop all capabilities`);
  if (!service.security_opt?.some((entry) => entry.startsWith('no-new-privileges'))) {
    throw new Error(`${serviceName} does not set no-new-privileges`);
  }
}
// VictoriaMetrics' API (admin endpoints included) has no authentication.
if ((config.services.victoriametrics.ports ?? []).length !== 0) {
  throw new Error('victoriametrics must not publish a host port');
}
// The Backend is reached only through the TLS edge on the same host.
const backendPorts = backend.ports ?? [];
if (backendPorts.length !== 1
  || backendPorts[0].host_ip !== '127.0.0.1'
  || String(backendPorts[0].published) !== '3001'
  || Number(backendPorts[0].target) !== 3001) {
  throw new Error(`backend must publish only 127.0.0.1:3001, got ${JSON.stringify(backendPorts)}`);
}
for (const [serviceName, service] of Object.entries(config.services ?? {})) {
  for (const port of service.ports ?? []) {
    if (port.host_ip !== '127.0.0.1') {
      throw new Error(`${serviceName} publishes a port beyond loopback: ${JSON.stringify(port)}`);
    }
  }
}
const tmpfs = Array.isArray(backend.tmpfs)
  ? backend.tmpfs
  : Object.entries(backend.tmpfs ?? {}).map(([path, options]) => `${path}:${options}`);
const tmp = tmpfs.find((entry) => entry.startsWith('/tmp:'));
for (const expected of ['rw', 'nosuid', 'nodev', 'noexec', 'uid=10001', 'gid=10001']) {
  if (!tmp?.includes(expected)) throw new Error(`backend /tmp tmpfs is missing ${expected}`);
}
NODE

# The Backend's role owns its database and nothing else.
rg -q 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS' deploy/postgres-app-role.sh
rg -q 'CREATE DATABASE nyabase OWNER nyabase' deploy/postgres-app-role.sh
[[ -x deploy/postgres-app-role.sh ]] || { echo "deploy/postgres-app-role.sh must be executable" >&2; exit 1; }
rg -q '^DATABASE_URL=postgresql://nyabase:CHANGE_ME_NYABASE_DB@postgres:5432/nyabase$' deploy/.env.example
if rg -n '^POSTGRES_(USER|DB)=' deploy/.env.example; then
  echo "deploy/.env.example must not rename the superuser or the database" >&2
  exit 1
fi
rg -q '^FROM node:22-slim@sha256:[0-9a-f]{64} AS builder$' deploy/Dockerfile.backend
rg -q '^FROM node:22-slim@sha256:[0-9a-f]{64} AS runner$' deploy/Dockerfile.backend
rg -q '^USER 10001:10001$' deploy/Dockerfile.backend
if rg -n 'packages/agent|dockerd|dockerRoot|nyabase-agent' deploy/Dockerfile.backend; then
  echo "Backend image still contains the retired host runtime" >&2
  exit 1
fi
for unit in nyabase-agent nyabase-http-proxy nyabase-ssh-proxy; do
  unit_file="deploy/$unit.service"
  [[ -f "$unit_file" ]] || { echo "missing systemd unit: $unit_file" >&2; exit 1; }
  for directive in '^NoNewPrivileges=true$' '^ProtectSystem=strict$' '^Restart=always$'; do
    rg -q "$directive" "$unit_file" || {
      echo "$unit_file is missing $directive" >&2
      exit 1
    }
  done
  if rg -q '^User=root$' "$unit_file"; then
    echo "$unit_file must not run as root" >&2
    exit 1
  fi
done
for proxy in http ssh; do
  unit_file="deploy/nyabase-$proxy-proxy.service"
  rg -q '^LimitNOFILE=65536$' "$unit_file"
  rg -q "^EnvironmentFile=/etc/nyabase/$proxy-proxy.env$" "$unit_file"
  [[ -f "deploy/$proxy-proxy.env.example" ]] || {
    echo "missing deploy/$proxy-proxy.env.example" >&2
    exit 1
  }
  # The control link must be TLS outside loopback; the examples must not teach ws://.
  if rg -n '^NYABASE_BACKEND_WS=ws://' "deploy/$proxy-proxy.env.example"; then
    echo "deploy/$proxy-proxy.env.example uses a plaintext Backend URL" >&2
    exit 1
  fi
done
rg -q '^AmbientCapabilities=CAP_NET_BIND_SERVICE$' deploy/nyabase-http-proxy.service
rg -q '^CapabilityBoundingSet=CAP_NET_BIND_SERVICE$' deploy/nyabase-http-proxy.service
rg -q '^CapabilityBoundingSet=$' deploy/nyabase-ssh-proxy.service
if rg -n 'INCUS_CA|ws://<backend-host>' deploy/.env.example deploy/OPERATIONS.md; then
  echo "deployment files still reference the retired Incus mTLS or plaintext Backend URL" >&2
  exit 1
fi
git check-ignore -q deploy/config.yaml || {
  echo "deploy/config.yaml must be ignored by git" >&2
  exit 1
}
rg -q 'image: postgres:18\.4-bookworm@sha256:[0-9a-f]{64}' .github/workflows/ci.yml
for deployment_file in \
  deploy/docker-compose.yml \
  deploy/Dockerfile.backend \
  deploy/config.example.yaml \
  deploy/.env.example \
  deploy/http-proxy.env.example \
  deploy/ssh-proxy.env.example \
  deploy/nyabase-http-proxy.service \
  deploy/nyabase-ssh-proxy.service \
  deploy/OPERATIONS.md; do
  # Host network routing (netplan `via: <GATEWAY>`, networkd `Gateway=`) is not
  # the retired Backend gateway module.
  if rg -n -i \
    '(^|[^[:alnum:]_])gateway([^[:alnum:]_]|$)|dockerd|dockerRoot|remote[-_]fs|data[-_]dir|workflow|agent[-_]task' \
    "$deployment_file" \
    | rg -v '<GATEWAY>|Gateway=' ; then
    echo "obsolete runtime terminology remains in $deployment_file" >&2
    exit 1
  fi
done
echo "deployment hardening contract tests passed"
