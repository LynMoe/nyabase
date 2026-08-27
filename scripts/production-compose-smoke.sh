#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 0 ]]; then
  echo "Usage: bash scripts/production-compose-smoke.sh" >&2
  exit 2
fi

for command_name in docker curl node openssl; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "required command not found: $command_name" >&2
    exit 1
  }
done
docker compose version >/dev/null

smoke_root="$(mktemp -d)"
smoke_project="nyabase-smoke-$$"
smoke_env="$smoke_root/smoke.env"
smoke_config="$smoke_root/config.yaml"
smoke_override="$smoke_root/override.yaml"
smoke_image="${NYABASE_SMOKE_IMAGE:-nyabase-backend:ci}"

cleanup_smoke() {
  local status="$?"
  if [[ "$status" -ne 0 ]]; then
    docker compose \
      --project-name "$smoke_project" \
      --env-file "$smoke_env" \
      -f deploy/docker-compose.yml \
      -f "$smoke_override" \
      ps >&2 || true
    docker compose \
      --project-name "$smoke_project" \
      --env-file "$smoke_env" \
      -f deploy/docker-compose.yml \
      -f "$smoke_override" \
      logs --no-color --tail 200 backend postgres redis >&2 || true
  fi
  docker compose \
    --project-name "$smoke_project" \
    --env-file "$smoke_env" \
    -f deploy/docker-compose.yml \
    -f "$smoke_override" \
    down --volumes --remove-orphans --timeout 10 >/dev/null 2>&1 || true
  rm -rf "$smoke_root"
  return "$status"
}
trap cleanup_smoke EXIT

incus_client_cert="$smoke_root/incus-client-cert.pem"
incus_client_key="$smoke_root/incus-client-key.pem"
incus_ca="$smoke_root/incus-ca.pem"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj "/CN=nyabase-smoke-incus" \
  -keyout "$incus_client_key" \
  -out "$incus_client_cert" >/dev/null 2>&1
cp -f "$incus_client_cert" "$incus_ca"
chmod 0600 "$incus_client_cert" "$incus_client_key" "$incus_ca"

{
  echo 'POSTGRES_DB=nyabase'
  echo 'POSTGRES_USER=nyabase'
  echo 'POSTGRES_PASSWORD=smoke-postgres-password'
  echo 'DATABASE_URL=postgresql://nyabase:smoke-postgres-password@postgres:5432/nyabase'
  echo 'REDIS_PASSWORD=smoke-redis-password'
  echo 'REDIS_URL=redis://nyabase:smoke-redis-password@redis:6379/0'
  echo "INCUS_CLIENT_CERT_SOURCE=$incus_client_cert"
  echo "INCUS_CLIENT_KEY_SOURCE=$incus_client_key"
  echo "INCUS_CA_SOURCE=$incus_ca"
  echo 'REDIS_KEY_PREFIX=nyabase-smoke:'
  echo 'REDIS_MAXMEMORY=64mb'
  echo 'DB_POOL_MAX=4'
  echo 'PG_CONNECTION_TIMEOUT_MS=30000'
  echo 'DB_IDLE_TIMEOUT_MS=10000'
  echo 'DB_STATEMENT_TIMEOUT_MS=10000'
  echo 'PG_LOCK_TIMEOUT_MS=3000'
  echo 'PG_IDLE_IN_TRANSACTION_TIMEOUT_MS=10000'
  echo 'PG_READINESS_TIMEOUT_MS=3000'
  echo 'DB_MIGRATIONS_RUN=true'
  echo 'VM_RETENTION_PERIOD=1d'
  echo 'VM_MIN_FREE_DISK_SPACE_BYTES=16MiB'
  echo 'VMAGENT_MAX_DISK_USAGE_PER_URL=64MiB'
  echo "SMOKE_CONFIG_PATH=$smoke_config"
  echo "NYABASE_SMOKE_IMAGE=$smoke_image"
} >"$smoke_env"
chmod 0600 "$smoke_env"

{
  echo 'runtime:'
  echo '  nodeEnv: production'
  echo '  role: all'
  echo 'incus:'
  echo '  preflightImageAlias: smoke-image'
  echo '  preflightEgressUrl: https://example.invalid/health'
  echo '  requestTimeoutMs: 10000'
  echo '  operationWaitTimeoutMs: 120000'
  echo 'server:'
  echo '  port: 3001'
  echo '  corsOrigin: ""'
  echo 'branding:'
  echo '  title: nyabase-smoke'
  echo '  description: production compose smoke'
  echo 'auth:'
  echo '  jwtSecret: "smoke-jwt-secret-000000000000000000000000000000000000000000000000"'
  echo '  jwtExpiresIn: 15m'
  echo '  refreshTokenExpiresDays: 7'
  echo '  adminInitPassword: "smoke-admin-password"'
  echo 'database:'
  echo '  url: "postgresql://nyabase:smoke-postgres-password@postgres:5432/nyabase"'
  echo '  poolMax: 4'
  echo '  idleTimeoutMs: 10000'
  echo '  statementTimeoutMs: 10000'
  echo '  migrationsRun: true'
  echo 'redis:'
  echo '  url: "redis://nyabase:smoke-redis-password@redis:6379/0"'
  echo '  keyPrefix: "nyabase-smoke:"'
  echo 'metrics:'
  echo '  victoriaMetricsUrl: http://victoriametrics:8428'
  echo '  vmagentUrl: http://vmagent:8429'
  echo 'http:'
  echo '  proxyToken: "smoke_http_proxy_token_00000000000000000000000000000000"'
  echo 'ssh:'
  echo '  keyEncryptionSecret: "smoke-ssh-encryption-secret-000000000000000000000000000000"'
  echo '  proxyToken: "smoke_ssh_proxy_token_000000000000000000000000000000000"'
  echo '  proxyPublicHost: localhost'
  echo '  proxyPublicPort: 2222'
  echo '  proxySnapshotStaleMs: 300000'
} >"$smoke_config"
chmod 0400 "$smoke_config"
if ! chown 10001:10001 "$smoke_config" 2>/dev/null; then
  command -v sudo >/dev/null 2>&1 || {
    echo "chown to the Backend UID requires root or passwordless sudo" >&2
    exit 1
  }
  sudo -n chown 10001:10001 "$smoke_config"
fi
[[ "$(stat -c '%u:%g:%a' "$smoke_config")" == '10001:10001:400' ]]

cat >"$smoke_override" <<'YAML'
services:
  backend:
    image: ${NYABASE_SMOKE_IMAGE}
    build: !reset null
    ports: !override
      - "127.0.0.1::3001"
    volumes: !override
      - ${SMOKE_CONFIG_PATH}:/etc/nyabase/config.yaml:ro
  victoriametrics:
    ports: !override
      - "127.0.0.1::8428"
YAML

compose=(
  docker compose
  --project-name "$smoke_project"
  --env-file "$smoke_env"
  -f deploy/docker-compose.yml
  -f "$smoke_override"
)

timeout 180 "${compose[@]}" up -d --wait --wait-timeout 120
backend_container="$("${compose[@]}" ps -q backend)"
redis_container="$("${compose[@]}" ps -q redis)"
[[ -n "$backend_container" ]]
[[ -n "$redis_container" ]]
backend_port="$("${compose[@]}" port backend 3001 | sed -E 's/.*:([0-9]+)$/\1/')"
curl_probe() {
  curl --fail --silent --show-error \
    --retry 60 --retry-all-errors --retry-delay 1 \
    "$1" >/dev/null
}
curl_probe "http://127.0.0.1:${backend_port}/api/health/live"
curl_probe "http://127.0.0.1:${backend_port}/api/health/ready"
node scripts/http-load-gate.mjs \
  "http://127.0.0.1:${backend_port}/api/health/ready" 128 8

for forbidden_client_command in 'ACL LIST' 'CONFIG GET dir' 'CLIENT LIST'; do
  acl_output="$smoke_root/redis-acl-${forbidden_client_command// /-}.txt"
  docker exec "$redis_container" sh -ec \
    'REDISCLI_AUTH="$0" redis-cli --user nyabase --no-auth-warning "$@"' \
    'smoke-redis-password' $forbidden_client_command >"$acl_output" 2>&1 || true
  if ! grep -q 'NOPERM' "$acl_output"; then
    echo "Redis ACL unexpectedly allowed: $forbidden_client_command" >&2
    sed -n '1,10p' "$acl_output" >&2
    exit 1
  fi
done

"${compose[@]}" stop --timeout 10 redis
curl_probe "http://127.0.0.1:${backend_port}/api/health/live"
curl_probe "http://127.0.0.1:${backend_port}/api/health/ready"
"${compose[@]}" up -d redis
timeout 60 bash -c '
  api_url="$1"
  until curl --fail --silent "$api_url" >/dev/null; do
    sleep 1
  done
' _ \
  "http://127.0.0.1:${backend_port}/api/health/ready"

docker inspect "$backend_container" | node -e '
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const [container] = JSON.parse(input);
  const host = container.HostConfig;
  if (container.Config.User !== "10001:10001") throw new Error("unexpected runtime user");
  if (host.ReadonlyRootfs !== true) throw new Error("root filesystem is writable");
  if (!host.CapDrop?.includes("ALL")) throw new Error("capabilities were not dropped");
  if (!host.SecurityOpt?.some((entry) => entry.startsWith("no-new-privileges"))) {
    throw new Error("no-new-privileges is absent");
  }
  if (!(host.NanoCpus > 0) || !(host.Memory > 0) || !(host.PidsLimit > 0)) {
    throw new Error("backend resource limits are incomplete");
  }
  const tmp = host.Tmpfs?.["/tmp"] ?? "";
  for (const expected of ["rw", "nosuid", "nodev", "noexec", "uid=10001", "gid=10001"]) {
    if (!tmp.includes(expected)) throw new Error(`/tmp tmpfs is missing ${expected}`);
  }
});'

[[ "$(docker exec "$backend_container" id -u)" == 10001 ]]
docker exec "$backend_container" test -r /etc/nyabase/config.yaml
docker exec "$backend_container" sh -ec 'touch /tmp/nyabase-smoke && rm /tmp/nyabase-smoke'
if docker exec "$backend_container" sh -ec 'touch /app/should-not-write' 2>/dev/null; then
  echo "read-only root filesystem unexpectedly accepted a write" >&2
  exit 1
fi

"${compose[@]}" down --volumes --remove-orphans --timeout 10
[[ -z "$("${compose[@]}" ps -aq)" ]]
trap - EXIT
rm -rf "$smoke_root"
echo "production Compose control-plane Redis recovery smoke passed with a non-root read-only Backend"
