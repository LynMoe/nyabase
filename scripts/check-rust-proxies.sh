#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 0 ]]; then
  echo "Usage: bash scripts/check-rust-proxies.sh" >&2
  exit 2
fi

cargo_bin="${CARGO:-}"
if [[ -z "$cargo_bin" ]]; then
  if command -v cargo >/dev/null 2>&1; then
    cargo_bin="$(command -v cargo)"
  elif [[ -n "${HOME:-}" && -x "$HOME/.cargo/bin/cargo" ]]; then
    cargo_bin="$HOME/.cargo/bin/cargo"
  fi
fi
if [[ -z "$cargo_bin" || ! -x "$cargo_bin" ]]; then
  echo "Cargo is required to verify the production SSH and HTTP proxies" >&2
  exit 1
fi

for crate in tools/ssh-proxy tools/http-proxy; do
  (
    cd "$crate"
    "$cargo_bin" fmt --check
    "$cargo_bin" test --locked
    "$cargo_bin" clippy --locked -- -D warnings
    "$cargo_bin" build --release --locked
  )
done
