#!/bin/bash
# nyabase Agent Install Script
# Run as root on the target server

set -euo pipefail

NODE_VERSION="22"
AGENT_DIR="/opt/nyabase-agent"
BIN_DIR="/opt/nyabase-agent/bin"
CONFIG_DIR="/etc/nyabase"
STATE_DIR="/var/lib/nyabase-agent"
PHYSICAL_MUTATION_LOCK="$STATE_DIR/physical-mutation.lock"

echo "=== nyabase Agent Installer ==="

# OS check: only Ubuntu and Debian are supported
if [ -f /etc/os-release ]; then
  . /etc/os-release
  case "${ID:-}${ID_LIKE:-}" in
    *ubuntu*|*debian*) ;;
    *)
      echo "ERROR: Unsupported OS: ${PRETTY_NAME:-unknown}. Only Ubuntu and Debian are supported."
      exit 1
      ;;
  esac
else
  echo "ERROR: /etc/os-release not found. Only Ubuntu and Debian are supported."
  exit 1
fi

# dockerd check: must already be installed by the operator
if ! command -v dockerd &>/dev/null; then
  echo "ERROR: dockerd not found in PATH."
  echo "Please install docker-ce before running this installer:"
  echo "  https://docs.docker.com/engine/install/ubuntu/"
  exit 1
fi
echo "Found dockerd at $(command -v dockerd)"

if ! command -v flock &>/dev/null; then
  echo "ERROR: flock not found in PATH (install util-linux)."
  exit 1
fi
echo "Found flock at $(command -v flock)"

# Disable and stop the system docker.service if running — nyabase manages its own daemon.
if systemctl is-active --quiet docker.service 2>/dev/null; then
  echo "WARNING: system docker.service is active. nyabase will manage its own dockerd."
  echo "To avoid conflicts, consider masking the system service:"
  echo "  systemctl mask docker.service"
fi

# Install Node.js if not present
if ! command -v node &>/dev/null; then
  echo "Installing Node.js ${NODE_VERSION}..."
  curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
  apt-get install -y nodejs
fi

# Install pnpm
npm install -g pnpm@9.15.0 --no-update-notifier

# Create directories
mkdir -p "$AGENT_DIR" "$BIN_DIR" "$CONFIG_DIR"
install -d -o root -g root -m 0700 "$STATE_DIR"
if [ -L "$PHYSICAL_MUTATION_LOCK" ] || { [ -e "$PHYSICAL_MUTATION_LOCK" ] && [ ! -f "$PHYSICAL_MUTATION_LOCK" ]; }; then
  echo "ERROR: unsafe physical mutation lock path: $PHYSICAL_MUTATION_LOCK"
  exit 1
fi
# Never replace or unlink this inode during upgrades: old helpers may still
# hold its flock after the Agent process itself has exited.
touch "$PHYSICAL_MUTATION_LOCK"
chown root:root "$PHYSICAL_MUTATION_LOCK"
chmod 0600 "$PHYSICAL_MUTATION_LOCK"

# Copy agent files (assumes build artifacts are in ./dist/)
if [ -f "dist/nyabase-agent" ]; then
  # Pre-built binary mode
  cp "dist/nyabase-agent" "$BIN_DIR/nyabase-agent"
  chmod +x "$BIN_DIR/nyabase-agent"
else
  # Source mode
  cp -r packages/agent/dist "$AGENT_DIR/"
  cp -r packages/agent/package.json "$AGENT_DIR/"
  cp -r packages/common/dist "$AGENT_DIR/../common-dist/"
  cd "$AGENT_DIR"
  NODE_ENV=production pnpm install --prod
  cd -
  cat > "$BIN_DIR/nyabase-agent" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cd /opt/nyabase-agent
exec /usr/bin/node /opt/nyabase-agent/dist/main.js "$@"
EOF
  chmod +x "$BIN_DIR/nyabase-agent"
fi

# Install systemd service
cp deploy/agent.systemd.service /etc/systemd/system/nyabase-agent.service

# Copy example config if no config exists
if [ ! -f "$CONFIG_DIR/agent.yaml" ]; then
  install -o root -g root -m 0600 deploy/agent.example.yaml "$CONFIG_DIR/agent.yaml"
  echo "IMPORTANT: Edit $CONFIG_DIR/agent.yaml with your configuration before starting"
else
  chown root:root "$CONFIG_DIR/agent.yaml"
  chmod 0600 "$CONFIG_DIR/agent.yaml"
fi

systemctl daemon-reload

echo ""
echo "=== Installation complete ==="
echo "1. Edit $CONFIG_DIR/agent.yaml"
echo "2. systemctl enable --now nyabase-agent"
echo "3. journalctl -fu nyabase-agent   # watch logs"
echo ""
echo "The agent will automatically create and manage nyabase-docker.service"
echo "using the dockerRoot path from agent.yaml."
