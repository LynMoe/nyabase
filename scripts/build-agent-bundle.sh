#!/usr/bin/env bash
# Build the self-contained nyabase-agent bundle a host runs:
#   <out>/agent/                          dist, package.json, build-info.json and the
#                                         runtime node_modules (@nyabase/common, zod, ws)
#   <out>/nyabase-agent-<version>.tar.gz  the same tree under `agent/`, reproducible
#                                         for a clean checkout (sorted, commit mtime, no owners)
# The version is `<package version>+g<commit>` (`.dirty` for uncommitted changes); the
# agent reports it in hello and the server page shows it.
#
# Usage: scripts/build-agent-bundle.sh [--skip-build] [<out dir>]   (default out: dist-agent)
# Prints the tarball path. --skip-build reuses packages/{common,agent}/dist.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build=1
if [[ "${1:-}" == --skip-build ]]; then
  build=0
  shift
fi
[[ $# -le 1 ]] || { echo "usage: $0 [--skip-build] [<out dir>]" >&2; exit 2; }
out="${1:-$repo/dist-agent}"
mkdir -p "$out"
out="$(cd "$out" && pwd)"

if [[ $build -eq 1 ]]; then
  # From scratch, so no output of a since-deleted source rides along.
  (cd "$repo" && pnpm --filter @nyabase/agent exec tsc -b --clean >&2 \
    && pnpm --filter @nyabase/common build >&2 && pnpm --filter @nyabase/agent build >&2)
fi
agent="$repo/packages/agent"
common="$repo/packages/common"
[[ -f "$agent/dist/main.js" && -f "$common/dist/index.js" ]] \
  || { echo "agent or common is not built (run without --skip-build)" >&2; exit 1; }

commit="$(git -C "$repo" rev-parse HEAD)"
dirty=""
if [[ -n "$(git -C "$repo" status --porcelain -- packages/agent packages/common pnpm-lock.yaml)" ]]; then
  dirty=".dirty"
fi
package_version="$(node -p 'require(process.argv[1]).version' "$agent/package.json")"
version="$package_version+g${commit:0:12}$dirty"
commit_time="$(git -C "$repo" log -1 --format=%ct HEAD)"

tree="$out/agent"
rm -rf "$tree"
mkdir -p "$tree/node_modules/@nyabase/common"
cp -R "$agent/dist" "$agent/package.json" "$tree/"
printf '{\n  "version": "%s",\n  "commit": "%s"\n}\n' "$version" "$commit" >"$tree/build-info.json"
cp -R "$common/dist" "$common/package.json" "$tree/node_modules/@nyabase/common/"
zod="$(cd "$common" && node -p 'require("path").dirname(require.resolve("zod/package.json"))')"
ws="$(cd "$agent" && node -p 'require("path").dirname(require.resolve("ws/package.json"))')"
cp -RL "$zod" "$tree/node_modules/zod"
cp -RL "$ws" "$tree/node_modules/ws"
# Test files and incremental build state are not part of what a host runs.
find "$tree" \( -name '*.test.*' -o -name '*.tsbuildinfo' \) -delete

tarball="$out/nyabase-agent-$version.tar.gz"
# Modes are normalized too: copied dependencies keep the build host's modes (a
# pnpm store can hold 0700/0600 trees), which the unprivileged agent user could
# not read and which would make the bytes depend on the build host.
tar -C "$out" --sort=name --mtime="@$commit_time" --owner=0 --group=0 --numeric-owner \
  --mode='u=rwX,go=rX' -cf - agent | gzip -n >"$tarball"
echo "$tarball"
