#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

ENV_FILE="${NYABASE_TEST_ENV_FILE:-test/config/local.env}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE" >&2
  exit 1
fi

set -a
source "$ENV_FILE"
set +a

if [[ "$DB_PATH" != /* ]]; then
  DB_PATH="$ROOT/$DB_PATH"
fi
export DB_PATH
CONFIG_FILE="${NYABASE_CONFIG_FILE:-$ROOT/test/runtime/config.yaml}"
export CONFIG_FILE

LOG_DIR="$ROOT/test/runtime/logs"
BACKEND_LOG="$LOG_DIR/backend.log"
FRONTEND_LOG="$LOG_DIR/frontend.log"
BACKEND_PID_FILE="$LOG_DIR/backend.pid"
FRONTEND_PID_FILE="$LOG_DIR/frontend.pid"

mkdir -p "$(dirname "$DB_PATH")" "$LOG_DIR" test/runtime/agents test/runtime/db

mkdir -p "$(dirname "$CONFIG_FILE")"
cat > "$CONFIG_FILE" <<EOF
runtime:
  nodeEnv: ${NODE_ENV}
server:
  port: ${PORT}
  corsOrigin: "${CORS_ORIGIN}"
branding:
  title: nyabase
  description: 开发容器管理平台
auth:
  jwtSecret: "${JWT_SECRET}"
  jwtExpiresIn: "${JWT_EXPIRES_IN:-15m}"
  refreshTokenExpiresDays: ${REFRESH_TOKEN_EXPIRES_DAYS:-7}
  adminInitPassword: "${ADMIN_INIT_PASSWORD}"
database:
  driver: sqlite
  path: "${DB_PATH}"
  synchronize: ${DB_SYNC}
  migrationsRun: ${DB_MIGRATIONS_RUN}
metrics:
  victoriaMetricsUrl: "${VICTORIA_METRICS_URL}"
http:
  proxyToken: "${HTTP_PROXY_TOKEN:?HTTP_PROXY_TOKEN is required}"
ssh:
  keyEncryptionSecret: "${SSH_KEY_ENCRYPTION_SECRET:-$JWT_SECRET}"
  proxyToken: "${SSH_PROXY_TOKEN:?SSH_PROXY_TOKEN is required}"
  proxyPublicHost: "${SSH_PROXY_PUBLIC_HOST:-}"
  proxyPublicPort: ${SSH_PROXY_PUBLIC_PORT:-2222}
  proxySnapshotStaleMs: ${SSH_PROXY_SNAPSHOT_STALE_MS:-300000}
EOF

echo "Starting VictoriaMetrics on 127.0.0.1:8428..."
docker start nyabase-vm >/dev/null 2>&1 || \
  docker run -d --name nyabase-vm --restart=unless-stopped \
    -p 127.0.0.1:8428:8428 \
    -v nyabase-vm-data:/victoria-metrics-data \
    victoriametrics/victoria-metrics:v1.101.0 \
    --retentionPeriod=12 \
    --storageDataPath=/victoria-metrics-data >/dev/null

echo "Building common/backend..."
pnpm --filter @nyabase/common build
pnpm --filter @nyabase/backend build

bash test/scripts/stop-local.sh

echo "Starting backend on port $PORT with DB $DB_PATH..."
(
  cd "$ROOT/packages/backend"
  nohup setsid env \
    NYABASE_CONFIG_FILE="$CONFIG_FILE" \
    node -r tsconfig-paths/register dist/main.js > "$BACKEND_LOG" 2>&1 < /dev/null &
  pid=$!
  echo "$pid" > "$BACKEND_PID_FILE"
  disown "$pid" 2>/dev/null || true
)

echo "Waiting for backend..."
for _ in $(seq 1 40); do
  if curl -sS "http://localhost:${PORT}/api/auth/me" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if ! curl -sS "http://localhost:${PORT}/api/auth/me" >/dev/null 2>&1; then
  echo "Backend did not start. Last log lines:" >&2
  tail -50 "$BACKEND_LOG" >&2 || true
  exit 1
fi

echo "Starting frontend on port 5173..."
(
  cd "$ROOT/packages/frontend"
  nohup setsid pnpm exec vite --port 5173 --host 0.0.0.0 --strictPort > "$FRONTEND_LOG" 2>&1 < /dev/null &
  pid=$!
  echo "$pid" > "$FRONTEND_PID_FILE"
  disown "$pid" 2>/dev/null || true
)

echo "Waiting for frontend..."
for _ in $(seq 1 40); do
  if curl -sS http://localhost:5173/ >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if ! curl -sS http://localhost:5173/ >/dev/null 2>&1; then
  echo "Frontend did not start. Last log lines:" >&2
  tail -50 "$FRONTEND_LOG" >&2 || true
  exit 1
fi

BACKEND_PID_FILE="$BACKEND_PID_FILE" FRONTEND_PID_FILE="$FRONTEND_PID_FILE" BACKEND_LOG="$BACKEND_LOG" FRONTEND_LOG="$FRONTEND_LOG" CONFIG_FILE="$CONFIG_FILE" node - <<'NODE'
const fs = require('node:fs');
const path = 'test/runtime/local-services.json';
const data = {
  startedAt: new Date().toISOString(),
  frontendUrl: 'http://localhost:5173',
  backendUrl: 'http://localhost:3001',
  victoriaMetricsUrl: 'http://127.0.0.1:8428',
  dbPath: process.env.DB_PATH,
  configFile: process.env.CONFIG_FILE,
  backendPid: fs.existsSync(process.env.BACKEND_PID_FILE) ? fs.readFileSync(process.env.BACKEND_PID_FILE, 'utf8').trim() : null,
  frontendPid: fs.existsSync(process.env.FRONTEND_PID_FILE) ? fs.readFileSync(process.env.FRONTEND_PID_FILE, 'utf8').trim() : null,
  backendLog: process.env.BACKEND_LOG,
  frontendLog: process.env.FRONTEND_LOG,
};
fs.writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
NODE

echo "Frontend: http://localhost:5173"
echo "Backend:  http://localhost:${PORT}/api"
echo "Admin:    ${ADMIN_USERNAME:-admin} / ${ADMIN_INIT_PASSWORD}"
echo "DB:       $DB_PATH"
echo "Logs:     $BACKEND_LOG $FRONTEND_LOG"

if [[ -n "${SSH_PROXY_TOKEN:-}" ]]; then
  if [[ -f test/scripts/start-ssh-proxy.sh ]]; then
    bash test/scripts/start-ssh-proxy.sh
  else
    echo "SKIP: SSH proxy token is set but optional test/scripts/start-ssh-proxy.sh is missing" >&2
  fi
fi
