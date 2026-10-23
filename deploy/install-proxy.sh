#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage:
  install-proxy.sh ssh|http [--binary FILE]

Builds (or takes --binary) and installs one Rust proxy as a systemd service:
  /usr/local/bin/nyabase-<kind>-proxy
  /etc/nyabase/<kind>-proxy.env   (created from the example once, never overwritten)
  /etc/systemd/system/nyabase-<kind>-proxy.service

First run: the env file is created and the service is NOT started; edit
NYABASE_BACKEND_WS and the proxy token, then run the script again.
Later runs are upgrades: the binary and unit are replaced and the service
restarted (restarting the SSH proxy drops every Jump session).
Run from a checkout, as root.
EOF
  exit 2
}

die() {
  echo "install-proxy: $*" >&2
  exit 1
}

[[ $# -ge 1 ]] || usage
kind=$1
shift
case "$kind" in
  ssh | http) ;;
  *) usage ;;
esac
binary=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --binary)
      [[ $# -ge 2 ]] || usage
      binary=$2
      shift 2
      ;;
    *) usage ;;
  esac
done
[[ $(id -u) -eq 0 ]] || die "run as root"

name="nyabase-${kind}-proxy"
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
env_file="/etc/nyabase/${kind}-proxy.env"
unit="/etc/systemd/system/${name}.service"

if [[ -z "$binary" ]]; then
  if [[ -n "${SUDO_USER:-}" && "$SUDO_USER" != root ]]; then
    # Build as the invoking user: no root-owned target/ and no build scripts as root.
    sudo -H -u "$SUDO_USER" bash -lc 'cargo build --release --locked --manifest-path "$1" -p "$2"' \
      _ "$repo/tools/Cargo.toml" "$name" || die "cargo build failed (as $SUDO_USER)"
  else
    command -v cargo >/dev/null 2>&1 || die "cargo not found; install Rust or pass --binary"
    cargo build --release --locked --manifest-path "$repo/tools/Cargo.toml" -p "$name"
  fi
  binary="$repo/tools/target/release/$name"
fi
[[ -x "$binary" ]] || die "not an executable: $binary"

install -m 0755 "$binary" "/usr/local/bin/$name"
install -m 0644 "$repo/deploy/$name.service" "$unit"
# Created once and never re-chmodded: the DynamicUser proxy must be able to read
# a NYABASE_BACKEND_CA_FILE kept here; the env files themselves stay 0600.
[[ -d /etc/nyabase ]] || install -d -m 0755 /etc/nyabase
fresh=0
if [[ ! -e "$env_file" ]]; then
  install -m 0600 "$repo/deploy/${kind}-proxy.env.example" "$env_file"
  fresh=1
fi
systemctl daemon-reload

if [[ $fresh -eq 1 ]]; then
  echo "install-proxy: created $env_file; set NYABASE_BACKEND_WS and the proxy token, then run again." >&2
  exit 0
fi
systemctl enable "$name" >/dev/null
systemctl restart "$name"
sleep 2
if ! systemctl is-active --quiet "$name"; then
  journalctl -u "$name" -n 30 --no-pager >&2 || true
  die "$name did not stay up"
fi
echo "install-proxy: $name is running"
