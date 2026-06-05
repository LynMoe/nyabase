#!/bin/bash
# Build nyabase-agent as a standalone Node.js binary using esbuild + @yao-pkg/pkg.
# Switching from Bun resolves dockerode hijack hangs (oven-sh/bun#29012) by using
# the native Node.js HTTP implementation, which dockerode is designed against.
#
# The mount-helper Rust binary is embedded as a pkg asset inside the agent binary.
# On startup the agent extracts it to /var/lib/nyabase-agent/ automatically.
# The prebuilt static Dropbear binary is supplied under packages/agent/assets/dropbear
# and embedded the same way; this script does not build or download Dropbear.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$REPO_ROOT/dist"
BINARY_NAME="nyabase-agent"
HELPER_NAME="nyabase-mount-helper"
DROPBEAR_NAME="nyabase-dropbear"
DEFAULT_DROPBEAR_SRC="$REPO_ROOT/packages/agent/assets/dropbear/nyabase-dropbear-linux-x64"
NODE_TARGET="${NODE_TARGET:-node22-linux-x64}"
AGENT_PACKAGE_JSON="$REPO_ROOT/packages/agent/package.json"

cd "$REPO_ROOT"

AGENT_VERSION="$(
  node -e "const pkg = require(process.argv[1]); if (typeof pkg.version !== 'string' || pkg.version.trim().length === 0) process.exit(1); process.stdout.write(pkg.version.trim());" "$AGENT_PACKAGE_JSON"
)"
AGENT_VERSION_DEFINE="$(node -e "process.stdout.write(JSON.stringify(process.argv[1]));" "$AGENT_VERSION")"

# Load Rust toolchain if installed via rustup
if [ -f "$HOME/.cargo/env" ]; then
  # shellcheck source=/dev/null
  source "$HOME/.cargo/env"
fi

echo "=== Building mount-helper (Rust) ==="
cd "$REPO_ROOT/tools/mount-helper"
if cargo build --release --target x86_64-unknown-linux-musl 2>/dev/null; then
  HELPER_SRC="target/x86_64-unknown-linux-musl/release/$HELPER_NAME"
  echo "Built musl static binary: $HELPER_SRC"
else
  # fallback: dynamic binary (no musl toolchain installed)
  echo "musl target not available, building dynamic binary..."
  cargo build --release
  HELPER_SRC="target/release/$HELPER_NAME"
  echo "Built dynamic binary: $HELPER_SRC"
fi
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

# Place mount-helper alongside the bundle so pkg can embed it as an asset.
cp "$REPO_ROOT/tools/mount-helper/$HELPER_SRC" "$BUNDLE_DIR/$HELPER_NAME"

# Place Dropbear alongside the bundle so pkg can embed it as an asset.
cp "$DROPBEAR_SRC" "$BUNDLE_DIR/$DROPBEAR_NAME"
chmod 755 "$BUNDLE_DIR/$DROPBEAR_NAME"
cp "$DROPBEAR_SHA_SRC" "$BUNDLE_DIR/$DROPBEAR_NAME.sha256"

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
{"pkg": {"assets": ["$HELPER_NAME", "$DROPBEAR_NAME", "$DROPBEAR_NAME.sha256"]}}
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
echo ""
echo "Usage on target machine:"
echo "  $BINARY_NAME --config /etc/nyabase/agent.yaml"
