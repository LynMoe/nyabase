#!/bin/bash
# Build the two inseparable Agent release artifacts:
# dist/nyabase-agent and dist/nyabase-atomic-file-exchange.
# The installer deliberately refuses a release missing either binary.
# Switching from Bun resolves dockerode hijack hangs (oven-sh/bun#29012) by using
# the native Node.js HTTP implementation, which dockerode is designed against.
#
# The prebuilt static Dropbear server and dropbearkey binaries are supplied under
# packages/agent/assets/dropbear and embedded together; this script does not
# build or download Dropbear.
# The SFTP subsystem binary is built from tools/sftp-server as a static musl asset
# and embedded into the agent for injection into containers.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$REPO_ROOT/dist"
BINARY_NAME="nyabase-agent"
DROPBEAR_NAME="nyabase-dropbear"
DROPBEARKEY_NAME="nyabase-dropbearkey"
SFTP_NAME="nyabase-sftp-server"
ATOMIC_EXCHANGE_NAME="nyabase-atomic-file-exchange"
DEFAULT_DROPBEAR_SRC="$REPO_ROOT/packages/agent/assets/dropbear/nyabase-dropbear-linux-x64"
DEFAULT_DROPBEARKEY_SRC="$REPO_ROOT/packages/agent/assets/dropbear/nyabase-dropbearkey-linux-x64"
NODE_TARGET="${NODE_TARGET:-node22-linux-x64}"
AGENT_PACKAGE_JSON="$REPO_ROOT/packages/agent/package.json"

CARGO_BIN="${CARGO:-}"
if [ -z "$CARGO_BIN" ]; then
  if command -v cargo >/dev/null 2>&1; then
    CARGO_BIN="$(command -v cargo)"
  elif [ -n "${HOME:-}" ] && [ -x "$HOME/.cargo/bin/cargo" ]; then
    CARGO_BIN="$HOME/.cargo/bin/cargo"
  fi
fi
if [ -z "$CARGO_BIN" ] || [ ! -x "$CARGO_BIN" ]; then
  echo "ERROR: Cargo is required to build the static SFTP server." >&2
  echo "Set CARGO to an executable path or install Cargo in PATH or \$HOME/.cargo/bin." >&2
  exit 1
fi

cd "$REPO_ROOT"

echo "=== Building atomic file exchange helper (static musl) ==="
mkdir -p "$OUT_DIR"
musl-gcc -static -O2 -Wall -Wextra -Werror \
  -o "$OUT_DIR/$ATOMIC_EXCHANGE_NAME" \
  "$REPO_ROOT/tools/atomic-file-exchange/atomic-file-exchange.c"
chmod 0755 "$OUT_DIR/$ATOMIC_EXCHANGE_NAME"
"$OUT_DIR/$ATOMIC_EXCHANGE_NAME" --self-test /tmp

AGENT_VERSION="$(
  node -e "const pkg = require(process.argv[1]); if (typeof pkg.version !== 'string' || pkg.version.trim().length === 0) process.exit(1); process.stdout.write(pkg.version.trim());" "$AGENT_PACKAGE_JSON"
)"
AGENT_VERSION_DEFINE="$(node -e "process.stdout.write(JSON.stringify(process.argv[1]));" "$AGENT_VERSION")"

echo "=== Building SFTP server (Rust) ==="
cd "$REPO_ROOT/tools/sftp-server"
"$CARGO_BIN" build --release --target x86_64-unknown-linux-musl
SFTP_SRC="target/x86_64-unknown-linux-musl/release/$SFTP_NAME"
SFTP_SHA="$(sha256sum "$SFTP_SRC" | awk '{print $1; exit}')"
echo "Built static SFTP server: tools/sftp-server/$SFTP_SRC"
cd "$REPO_ROOT"

echo ""
echo "=== Building @nyabase/common ==="
pnpm --filter @nyabase/common build

cd "$REPO_ROOT/packages/agent"

mkdir -p "$OUT_DIR"
BUNDLE_DIR="$OUT_DIR/agent-bundle"
BUNDLE_FILE="$BUNDLE_DIR/agent.cjs"
mkdir -p "$BUNDLE_DIR"

DROPBEAR_SRC="${NYABASE_DROPBEAR_PATH:-}"
if [ -z "$DROPBEAR_SRC" ] && [ -f "$DEFAULT_DROPBEAR_SRC" ]; then
  DROPBEAR_SRC="$DEFAULT_DROPBEAR_SRC"
fi
if [ -z "$DROPBEAR_SRC" ]; then
  echo "ERROR: Dropbear asset source is not configured." >&2
  echo "Set NYABASE_DROPBEAR_PATH to a trusted static Dropbear binary, or vendor it at:" >&2
  echo "  $DEFAULT_DROPBEAR_SRC" >&2
  echo "This script does not build, download, or guess a Dropbear binary." >&2
  exit 1
fi
DROPBEAR_SHA_SRC="${NYABASE_DROPBEAR_SHA256_PATH:-$DROPBEAR_SRC.sha256}"
if [ ! -f "$DROPBEAR_SRC" ]; then
  echo "ERROR: Dropbear asset not found: $DROPBEAR_SRC" >&2
  exit 1
fi
if [ ! -f "$DROPBEAR_SHA_SRC" ]; then
  echo "ERROR: Dropbear sha256 sidecar not found: $DROPBEAR_SHA_SRC" >&2
  echo "Provide NYABASE_DROPBEAR_SHA256_PATH or place a .sha256 file next to the binary." >&2
  exit 1
fi
EXPECTED_DROPBEAR_SHA="$(awk '{print $1; exit}' "$DROPBEAR_SHA_SRC")"
ACTUAL_DROPBEAR_SHA="$(sha256sum "$DROPBEAR_SRC" | awk '{print $1; exit}')"
if [ "$EXPECTED_DROPBEAR_SHA" != "$ACTUAL_DROPBEAR_SHA" ]; then
  echo "ERROR: Dropbear sha256 mismatch for $DROPBEAR_SRC" >&2
  echo "Expected: $EXPECTED_DROPBEAR_SHA" >&2
  echo "Actual:   $ACTUAL_DROPBEAR_SHA" >&2
  exit 1
fi

DROPBEARKEY_SRC="${NYABASE_DROPBEARKEY_PATH:-}"
if [ -z "$DROPBEARKEY_SRC" ] && [ -f "$DEFAULT_DROPBEARKEY_SRC" ]; then
  DROPBEARKEY_SRC="$DEFAULT_DROPBEARKEY_SRC"
fi
if [ -z "$DROPBEARKEY_SRC" ]; then
  echo "ERROR: Dropbear key utility asset source is not configured." >&2
  echo "Set NYABASE_DROPBEARKEY_PATH or vendor it at:" >&2
  echo "  $DEFAULT_DROPBEARKEY_SRC" >&2
  exit 1
fi
DROPBEARKEY_SHA_SRC="${NYABASE_DROPBEARKEY_SHA256_PATH:-$DROPBEARKEY_SRC.sha256}"
if [ ! -f "$DROPBEARKEY_SRC" ] || [ ! -f "$DROPBEARKEY_SHA_SRC" ]; then
  echo "ERROR: Dropbear key utility or sha256 sidecar is missing." >&2
  exit 1
fi
EXPECTED_DROPBEARKEY_SHA="$(awk '{print $1; exit}' "$DROPBEARKEY_SHA_SRC")"
ACTUAL_DROPBEARKEY_SHA="$(sha256sum "$DROPBEARKEY_SRC" | awk '{print $1; exit}')"
if [ "$EXPECTED_DROPBEARKEY_SHA" != "$ACTUAL_DROPBEARKEY_SHA" ]; then
  echo "ERROR: Dropbear key utility sha256 mismatch for $DROPBEARKEY_SRC" >&2
  exit 1
fi

# Place Dropbear alongside the bundle so pkg can embed it as an asset.
cp "$DROPBEAR_SRC" "$BUNDLE_DIR/$DROPBEAR_NAME"
chmod 755 "$BUNDLE_DIR/$DROPBEAR_NAME"
cp "$DROPBEAR_SHA_SRC" "$BUNDLE_DIR/$DROPBEAR_NAME.sha256"
cp "$DROPBEARKEY_SRC" "$BUNDLE_DIR/$DROPBEARKEY_NAME"
chmod 755 "$BUNDLE_DIR/$DROPBEARKEY_NAME"
cp "$DROPBEARKEY_SHA_SRC" "$BUNDLE_DIR/$DROPBEARKEY_NAME.sha256"

# Place SFTP server alongside the bundle so pkg can embed it as an asset.
cp "$REPO_ROOT/tools/sftp-server/$SFTP_SRC" "$BUNDLE_DIR/$SFTP_NAME"
chmod 755 "$BUNDLE_DIR/$SFTP_NAME"
printf '%s  %s\n' "$SFTP_SHA" "$SFTP_NAME" > "$BUNDLE_DIR/$SFTP_NAME.sha256"

echo ""
echo "=== Bundling agent (esbuild → CJS) ==="
echo "Injecting agent version: $AGENT_VERSION"
# Bundle TypeScript source + all JS deps into a single CommonJS file.
# `cpu-features` is the only native dep we cannot bundle; ssh2 already
# wraps its require in try/catch, so leaving it external degrades gracefully.
./node_modules/.bin/esbuild src/main.ts \
  --bundle \
  --platform=node \
  --target=node22 \
  --format=cjs \
  --define:process.env.NYABASE_AGENT_VERSION="$AGENT_VERSION_DEFINE" \
  --external:cpu-features \
  --minify \
  --outfile="$BUNDLE_FILE"

echo ""
echo "=== Compiling Node.js binary ($NODE_TARGET) ==="
# Embed native assets via a temporary config file placed next to the bundle
# entry, so __dirname-relative reads resolve correctly at runtime.
cat > "$BUNDLE_DIR/pkg.config.json" << EOF
{"pkg": {"assets": ["$DROPBEAR_NAME", "$DROPBEAR_NAME.sha256", "$DROPBEARKEY_NAME", "$DROPBEARKEY_NAME.sha256", "$SFTP_NAME", "$SFTP_NAME.sha256"]}}
EOF
./node_modules/.bin/pkg \
  --targets "$NODE_TARGET" \
  --output "$OUT_DIR/$BINARY_NAME" \
  --compress GZip \
  -c "$BUNDLE_DIR/pkg.config.json" \
  "$BUNDLE_FILE"

rm -rf "$BUNDLE_DIR"

echo ""
echo "=== Done ==="
echo "Agent: $OUT_DIR/$BINARY_NAME  ($(du -sh "$OUT_DIR/$BINARY_NAME" | cut -f1))"
echo "Atomic exchange helper: $OUT_DIR/$ATOMIC_EXCHANGE_NAME  ($(du -sh "$OUT_DIR/$ATOMIC_EXCHANGE_NAME" | cut -f1))"
echo ""
echo "Usage on target machine:"
echo "  deploy/install-agent.sh  # installs and probes both required binaries"
