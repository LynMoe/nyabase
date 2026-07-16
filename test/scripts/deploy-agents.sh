#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

SECRETS="test/runtime/agents/agent-secrets.json"
ENV_FILE="${NYABASE_TEST_ENV_FILE:-test/config/local.env}"
if [[ ! -f "$SECRETS" ]]; then
  echo "Missing $SECRETS. Run: node test/scripts/register-agents.mjs" >&2
  exit 1
fi
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE" >&2
  exit 1
fi

echo "Building standalone agent binary..."
bash scripts/build-agent-binary.sh

deploy_one() {
  local key="$1"
  local ssh_target sudo_flag config_path sudo_prefix
  ssh_target="$(node -e "const s=require('./$SECRETS'); console.log(s.agents['$key'].ssh)")"
  sudo_flag="$(node -e "const s=require('./$SECRETS'); console.log(s.agents['$key'].sudo ? '1' : '0')")"
  config_path="$(node -e "const s=require('./$SECRETS'); console.log(s.agents['$key'].configPath)")"
  if [[ "$sudo_flag" == "1" ]]; then
    sudo_prefix="sudo -n "
  else
    sudo_prefix=""
  fi

  echo "Deploying $key agent to $ssh_target..."
  ssh "$ssh_target" "${sudo_prefix}systemctl stop nyabase-agent 2>/dev/null || true; ${sudo_prefix}rm -f /usr/local/bin/nyabase-agent"
  scp dist/nyabase-agent "$ssh_target:/tmp/nyabase-agent"
  scp "$config_path" "$ssh_target:/tmp/nyabase-agent.yaml"
  ssh "$ssh_target" "${sudo_prefix}mkdir -p /etc/nyabase; ${sudo_prefix}mv /tmp/nyabase-agent /usr/local/bin/nyabase-agent; ${sudo_prefix}chmod +x /usr/local/bin/nyabase-agent; ${sudo_prefix}mv /tmp/nyabase-agent.yaml /etc/nyabase/agent.yaml; ${sudo_prefix}chmod 600 /etc/nyabase/agent.yaml"
  ssh "$ssh_target" "${sudo_prefix}cat > /tmp/nyabase-agent.service" <<'EOF'
[Unit]
Description=nyabase Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
ExecStart=/usr/local/bin/nyabase-agent --config /etc/nyabase/agent.yaml
Restart=always
RestartSec=5
KillMode=control-group
TimeoutStopSec=30s
SendSIGKILL=yes
StandardOutput=journal
StandardError=journal
SyslogIdentifier=nyabase-agent
StateDirectory=nyabase-agent
StateDirectoryMode=0700

[Install]
WantedBy=multi-user.target
EOF
  ssh "$ssh_target" "${sudo_prefix}mv /tmp/nyabase-agent.service /etc/systemd/system/nyabase-agent.service; ${sudo_prefix}systemctl daemon-reload; ${sudo_prefix}systemctl enable --now nyabase-agent"
  ssh "$ssh_target" "${sudo_prefix}systemctl is-active nyabase-agent; ${sudo_prefix}journalctl -u nyabase-agent -n 8 --no-pager"
}

deploy_one cpu
deploy_one gpu

echo "Waiting for agents to report online..."
node - <<'NODE'
const fs = require('node:fs');
const env = Object.fromEntries(fs.readFileSync(process.env.NYABASE_TEST_ENV_FILE || 'test/config/local.env', 'utf8').split(/\r?\n/).filter((line) => line && !line.startsWith('#') && line.includes('=')).map((line) => {
  const i = line.indexOf('=');
  return [line.slice(0, i), line.slice(i + 1)];
}));
const secrets = require(process.cwd() + '/test/runtime/agents/agent-secrets.json');
const apiBase = `${(env.NYABASE_BACKEND_URL || 'http://localhost:3001').replace(/\/+$/, '')}/api`;

async function request(method, path, token, body) {
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} ${res.status}: ${text}`);
  return parsed;
}

(async () => {
  const login = await request('POST', '/auth/login', null, {
    username: env.ADMIN_USERNAME || 'admin',
    password: env.ADMIN_INIT_PASSWORD || 'admin123',
  });
  const token = login.accessToken;
  const expected = new Map(Object.entries(secrets.agents).map(([k, v]) => [v.serverId, k]));
  for (let i = 0; i < 60; i++) {
    const servers = await request('GET', '/admin/servers', token);
    const online = servers.filter((server) => expected.has(server.id) && server.status === 'online');
    if (online.length === expected.size) {
      for (const server of online) console.log(`${expected.get(server.id)} online: ${server.id}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const servers = await request('GET', '/admin/servers', token);
  for (const server of servers.filter((item) => expected.has(item.id))) {
    console.log(`${expected.get(server.id)} status=${server.status} id=${server.id}`);
  }
  process.exit(1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
NODE
