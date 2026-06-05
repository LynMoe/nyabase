#!/bin/bash
# nyabase Agent Install Script
# Run as root on the target server

set -euo pipefail

NODE_VERSION="22"
AGENT_DIR="/opt/nyabase-agent"
BIN_DIR="/opt/nyabase-agent/bin"
CONFIG_DIR="/etc/nyabase"
STATE_DIR="/var/lib/nyabase-agent"

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
npm install -g pnpm

# Create directories
mkdir -p "$AGENT_DIR" "$BIN_DIR" "$CONFIG_DIR" "$STATE_DIR"

# Copy agent files (assumes build artifacts are in ./dist/)
if [ -f "dist/nyabase-agent" ]; then
  # Pre-built binary mode
  cp "dist/nyabase-agent" "$AGENT_DIR/nyabase-agent"
  chmod +x "$AGENT_DIR/nyabase-agent"
else
  # Source mode
  cp -r packages/agent/dist "$AGENT_DIR/"
  cp -r packages/agent/package.json "$AGENT_DIR/"
  cp -r packages/common/dist "$AGENT_DIR/../common-dist/"
  cd "$AGENT_DIR"
  NODE_ENV=production pnpm install --prod
  cd -
fi

# Install systemd service
cp deploy/agent.systemd.service /etc/systemd/system/nyabase-agent.service

# Copy example config if no config exists
if [ ! -f "$CONFIG_DIR/agent.yaml" ]; then
  cp deploy/agent.example.yaml "$CONFIG_DIR/agent.yaml"
  echo "IMPORTANT: Edit $CONFIG_DIR/agent.yaml with your configuration before starting"
fi

systemctl daemon-reload

# ---------------------------------------------------------------------------
# One-time cleanup for upgrades from versions that used state.json
# ---------------------------------------------------------------------------
# state.json is no longer used. XFS project IDs are now derived from each
# user's numeric DB ID (numericId + 10000 offset), so old /etc/projects and
# /etc/projid entries keyed by UUID or old sequence numbers are obsolete.
#
# IMPORTANT: After this cleanup, all XFS quota limits and project/path bindings
# are gone. The backend will enqueue fresh durable quota.apply commands on the
# next agent reconnect, which will re-create XFS projects. Data directories on
# disk are NOT affected — only quota accounting is reset.
#
# RUNBOOK — run manually when upgrading from a state.json-based agent:
#   systemctl stop nyabase-agent
#   rm -f /var/lib/nyabase-agent/state.json /tmp/nyabase-agent-state.json
#   # Remove nyabase-managed lines from /etc/projects and /etc/projid:
#   grep -v '^[0-9]*:/var/lib/nyabase-docker' /etc/projects > /etc/projects.tmp && mv /etc/projects.tmp /etc/projects
#   grep -v '^nyabase_' /etc/projid > /etc/projid.tmp && mv /etc/projid.tmp /etc/projid
#   systemctl start nyabase-agent

# Remove stale state.json if present (safe to run on fresh installs too)
if [ -f /var/lib/nyabase-agent/state.json ]; then
  echo "Removing legacy state.json..."
  rm -f /var/lib/nyabase-agent/state.json /tmp/nyabase-agent-state.json
fi

echo ""
echo "=== Installation complete ==="
echo "1. Edit $CONFIG_DIR/agent.yaml"
echo "2. systemctl enable --now nyabase-agent"
echo "3. journalctl -fu nyabase-agent   # watch logs"
echo ""
echo "The agent will automatically create and manage nyabase-docker.service"
echo "using the dockerRoot path from agent.yaml."
echo ""
echo "NOTE: If upgrading from a state.json-based agent, see the RUNBOOK comment"
echo "      in this script for XFS quota reset instructions."
