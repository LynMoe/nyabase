#!/usr/bin/env bash

set -euo pipefail
umask 077

POC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$POC_DIR/lib.sh"
poc_init

if [[ -f "$STATE_FILE" ]]; then
  load_state
fi

collect_logs || true

for pid_file in "$PRIVATE_DIR/websocket-client.pid" "$PRIVATE_DIR/ssh-session.pid"; do
  if [[ -f "$pid_file" ]]; then
    pid="$(<"$pid_file")"
    if [[ "$pid" =~ ^[0-9]+$ ]]; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  fi
done

mapfile -t containers < <(docker ps -aq --filter "label=${RUN_LABEL_KEY}=${RUN_ID}")
if (( ${#containers[@]} > 0 )); then
  docker rm -f "${containers[@]}" >/dev/null
fi

mapfile -t networks < <(docker network ls -q --filter "label=${RUN_LABEL_KEY}=${RUN_ID}")
for network in "${networks[@]}"; do
  docker network rm "$network" >/dev/null
done

mapfile -t images < <(docker image ls -q --filter "label=${RUN_LABEL_KEY}=${RUN_ID}" | sort -u)
if (( ${#images[@]} > 0 )); then
  docker image rm -f "${images[@]}" >/dev/null
fi

[[ -z "$(docker ps -aq --filter "label=${RUN_LABEL_KEY}=${RUN_ID}")" ]]
[[ -z "$(docker network ls -q --filter "label=${RUN_LABEL_KEY}=${RUN_ID}")" ]]
[[ -z "$(docker image ls -q --filter "label=${RUN_LABEL_KEY}=${RUN_ID}")" ]]

if [[ -d "$PRIVATE_DIR" ]]; then
  case "$PRIVATE_DIR" in
    "$ARTIFACT_DIR/private") rm -rf -- "$PRIVATE_DIR" ;;
    *) echo "refusing to remove unexpected private directory: $PRIVATE_DIR" >&2; exit 1 ;;
  esac
fi

node "$POC_DIR/write-cleanup-evidence.mjs" "$ARTIFACT_DIR/cleanup-evidence.json" "$RUN_ID"
echo "Full proxy PoC cleanup passed: $ARTIFACT_DIR/cleanup-evidence.json"
