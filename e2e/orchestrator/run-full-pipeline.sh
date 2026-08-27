#!/usr/bin/env bash
set -euo pipefail
RUN_ID="${1:?run id required}"
ROOT=/root/nyabase
cd "$ROOT"

HOST_INPUTS=/tmp/nyabase-e2e-host-inputs.env
TOKEN_FILE="/tmp/nyabase-e2e-${RUN_ID}-trust-token.env"
[[ -f "$HOST_INPUTS" ]] || { echo "missing $HOST_INPUTS" >&2; exit 2; }
[[ -f "$TOKEN_FILE" ]] || { echo "missing $TOKEN_FILE" >&2; exit 2; }

# Start from host inputs, then apply run-scoped trust token.
set -a
# shellcheck disable=SC1090
source "$HOST_INPUTS"
# shellcheck disable=SC1090
source "$TOKEN_FILE"
set +a
unset E2E_RUN_ID E2E_RUNTIME_ROOT E2E_SEED_STATE E2E_CAPABILITIES || true

# Shared DB keeps a single SSHD image alias; seed requires the DB name to match this run.
if [[ -n "${E2E_DATABASE_URL:-}" && -n "${E2E_INCUS_IMAGE_ALIAS:-}" ]]; then
  echo "=== ALIGN IMAGE NAME for $RUN_ID ==="
  psql "$E2E_DATABASE_URL" -v ON_ERROR_STOP=1 -c \
    "UPDATE infra.images SET name = 'e2e-${RUN_ID}-sshd', updated_at = clock_timestamp() WHERE alias = '${E2E_INCUS_IMAGE_ALIAS}';"
fi

# Drop stale control-plane / ssh-proxy listeners from prior interrupted runs.
# Kill by port — avoid pgrep -f patterns that match this script's argv.
for _port in 2222; do
  while read -r pid; do
    [[ -z "$pid" ]] && continue
    kill "$pid" 2>/dev/null || true
  done < <(ss -lntp "sport = :${_port}" 2>/dev/null | sed -n "s/.*pid=\([0-9]\+\).*/\1/p" | sort -u)
done
# Kill control-plane listener on :3001 only (keep edge proxy on :18623).
while read -r pid; do
  [[ -z "$pid" ]] && continue
  kill "$pid" 2>/dev/null || true
done < <(ss -lntp "sport = :3001" 2>/dev/null | sed -n "s/.*pid=\([0-9]\+\).*/\1/p" | sort -u)
sleep 1

echo "=== BUILD $(date -u +%FT%TZ) RUN=$RUN_ID base=${E2E_BASE_URL:-missing} ==="
bash e2e/orchestrator/e2e.sh build "$RUN_ID" full
echo "=== UP $(date -u +%FT%TZ) ==="
bash e2e/orchestrator/e2e.sh up "$RUN_ID" full
RT="$ROOT/e2e/.runtime/$RUN_ID"
set -a
# shellcheck disable=SC1090
source "$RT/context.env"
set +a

# Peer Incus can drift off the active CP client cert; re-admit it before Playwright.
if [[ -n "${E2E_DATABASE_URL:-}" && -n "${E2E_INCUS_KEY_ENCRYPTION_SECRET:-}" && -n "${E2E_GPU_PEER_SERVER_ID:-}" ]]; then
  echo "=== PEER RETRUST $(date -u +%FT%TZ) ==="
  python3 "$ROOT/e2e/orchestrator/peer-retrust-active.py" \
    --database-url "$E2E_DATABASE_URL" \
    --secret "$E2E_INCUS_KEY_ENCRYPTION_SECRET" \
    --peer-server-id "$E2E_GPU_PEER_SERVER_ID" \
    || echo "WARN: peer retrust failed; cert rotation may hang"
fi

echo "=== SSH PROXY MACVLAN REACHABILITY $(date -u +%FT%TZ) ==="
REACHABILITY_ENV="$RT/ssh-proxy-reachability.env"
bash "$ROOT/e2e/orchestrator/ssh-proxy-macvlan-reachability.sh" | tee "$REACHABILITY_ENV"
# shellcheck disable=SC1090
set -a; source <(grep -E '^E2E_SSH_PROXY_' "$REACHABILITY_ENV"); set +a
: "${E2E_SSH_PROXY_HOST:?missing E2E_SSH_PROXY_HOST from reachability}"
: "${E2E_SSH_PROXY_BACKEND_WS:?missing E2E_SSH_PROXY_BACKEND_WS from reachability}"
: "${E2E_SSH_PROXY_NETNS:?missing E2E_SSH_PROXY_NETNS from reachability}"

# Prefer ssh.proxyToken — a bare proxyToken match hits http.proxyToken first.
TOKEN="$(python3 - <<PY
import re
text=open("""$NYABASE_CONFIG_FILE""").read()
m=re.search(r"(?ms)^ssh:\s*(?:.*\n)*?[ \t]*proxyToken:\s*['\"]?([^\s'\"]+)", text)
if not m:
    m=re.search(r"(?m)^[ \t]*proxyToken:\s*['\"]?([^\s'\"]+)", text)
print(m.group(1) if m else "")
PY
)"
echo "ssh_proxy_token_len=${#TOKEN}"
[[ ${#TOKEN} -ge 32 ]] || { echo "missing ssh.proxyToken in $NYABASE_CONFIG_FILE" >&2; exit 2; }
# Kill by port — avoid pgrep -f patterns that match this script's argv.
for _port in 2222; do
  while read -r pid; do
    [[ -z "$pid" ]] && continue
    kill "$pid" 2>/dev/null || true
  done < <(ss -lntp "sport = :${_port}" 2>/dev/null | sed -n "s/.*pid=\([0-9]\+\).*/\1/p" | sort -u)
done
# Also clear any proxy left inside the reachability netns.
ip netns pids "$E2E_SSH_PROXY_NETNS" 2>/dev/null | while read -r pid; do
  kill "$pid" 2>/dev/null || true
done
sleep 1
PROXY_PID="$(ip netns exec "$E2E_SSH_PROXY_NETNS" bash -c "
  nohup env \
    RUST_LOG='${RUST_LOG:-info}' \
    NYABASE_BACKEND_WS='$E2E_SSH_PROXY_BACKEND_WS' \
    NYABASE_SSH_LISTEN=0.0.0.0:2222 \
    SSH_PROXY_TOKEN='$TOKEN' \
    NYABASE_SSH_PROXY_ID='e2e-${RUN_ID}-ssh-proxy' \
    '$ROOT/tools/ssh-proxy/target/release/nyabase-ssh-proxy' \
    >'$RT/ssh-proxy.log' 2>&1 &
  echo \$!
")"
echo "$PROXY_PID" >"$RT/ssh-proxy.pid"
# Wait until the proxy has an installed routing snapshot from the control plane.
for _i in $(seq 1 30); do
  if rg -q "installed SSH proxy snapshot" "$RT/ssh-proxy.log" 2>/dev/null; then
    echo "ssh_proxy_snapshot=ready host=${E2E_SSH_PROXY_HOST}"
    break
  fi
  if ! kill -0 "$(cat "$RT/ssh-proxy.pid")" 2>/dev/null; then
    echo "ssh-proxy exited before snapshot install" >&2
    tail -40 "$RT/ssh-proxy.log" >&2 || true
    exit 2
  fi
  sleep 1
done
if ! rg -q "installed SSH proxy snapshot" "$RT/ssh-proxy.log" 2>/dev/null; then
  echo "ssh-proxy did not install a snapshot within 30s" >&2
  tail -40 "$RT/ssh-proxy.log" >&2 || true
  exit 2
fi
echo "=== HEALTH $(date -u +%FT%TZ) ==="
bash e2e/orchestrator/e2e.sh health "$RUN_ID"
echo "=== RUN $(date -u +%FT%TZ) ==="
set +e
E2E_SSH_PROXY_HOST="$E2E_SSH_PROXY_HOST" E2E_SSH_PROXY_PORT=2222 \
  bash e2e/orchestrator/e2e.sh run full "$RUN_ID"
RUN_RC=$?
set -e
echo "RUN_RC=$RUN_RC"
echo "=== DOWN $(date -u +%FT%TZ) ==="
bash e2e/orchestrator/e2e.sh down "$RUN_ID" || true
if [[ $RUN_RC -eq 0 ]]; then
  echo "=== RELEASE $(date -u +%FT%TZ) ==="
  bash e2e/orchestrator/e2e.sh release "$RUN_ID"
else
  echo "=== DIAGNOSE $(date -u +%FT%TZ) ==="
  bash e2e/orchestrator/e2e.sh diagnose "$RUN_ID" || true
fi
echo "=== DONE RUN_RC=$RUN_RC $(date -u +%FT%TZ) ==="
exit $RUN_RC
