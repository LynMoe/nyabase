#!/usr/bin/env bash
# `e2e.sh up`: build, create the run directory and database, start the
# control plane and both proxies, register the servers, start their agents,
# then register the rest of the lab (lib/bootstrap.ts).

# A self-contained agent tree: its dist plus @nyabase/common, zod and ws.
bundle_agent() {
  local out="$RUN_DIR/agent" agent="$REPO_ROOT/packages/agent" common="$REPO_ROOT/packages/common" zod ws
  zod="$(cd "$common" && node -p 'require("path").dirname(require.resolve("zod/package.json"))')"
  ws="$(cd "$agent" && node -p 'require("path").dirname(require.resolve("ws/package.json"))')"
  mkdir -p "$out/node_modules/@nyabase/common"
  cp -R "$agent/dist" "$agent/package.json" "$out/"
  cp -R "$common/dist" "$common/package.json" "$out/node_modules/@nyabase/common/"
  cp -RL "$zod" "$out/node_modules/zod"
  cp -RL "$ws" "$out/node_modules/ws"
}

# Every lab host gets a run-scoped agent: a transient systemd unit named
# nyabase-e2e-agent-<run>-s<n> with its files and credential in /var/tmp/<that name>.
# The agent dials the Backend; for a remote host that goes through an ssh reverse
# tunnel (pid in tunnel-s<n>.pid), so the Backend can stay on a loopback address.
# The one-time enrollment tokens come from the first bootstrap phase (enroll.env).
# `down` stops the unit, removes the directory and the tunnel (lib/lab-sweep.sh).
start_agents() {
  local idx var target name port url token i
  port="${E2E_AGENT_TUNNEL_PORT:-13901}"
  bundle_agent
  # shellcheck disable=SC1091
  source "$RUN_DIR/enroll.env"
  for idx in $E2E_SERVERS; do
    var="E2E_SERVER_${idx}_SSH"; target="${!var:-}"
    [[ -n "$target" ]] || die "$var is required in lab.env"
    var="E2E_SERVER_${idx}_ENROLLMENT_TOKEN"; token="${!var:-}"
    [[ -n "$token" ]] || die "bootstrap issued no enrollment token for server $idx"
    name="nyabase-e2e-agent-$RUN_ID-s$idx"
    if [[ "$target" == local ]]; then
      url="http://$E2E_LISTEN_HOST:$E2E_BACKEND_PORT"
    else
      start_detached "tunnel-s$idx" ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes \
        -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
        -R "127.0.0.1:$port:$E2E_LISTEN_HOST:$E2E_BACKEND_PORT" "$target"
      sleep 2
      run_owns_pid "$RUN_DIR/tunnel-s$idx.pid" \
        || die "the reverse tunnel to $target did not come up (see $RUN_DIR/tunnel-s$idx.log)"
      url="http://127.0.0.1:$port"
    fi
    printf 'NYABASE_BACKEND_URL=%s\nNYABASE_AGENT_ENROLLMENT_TOKEN=%s\nNYABASE_AGENT_STATE_DIR=/var/tmp/%s/state\n' \
      "$url" "$token" "$name" >"$RUN_DIR/agent-s$idx.env"
    chmod 600 "$RUN_DIR/agent-s$idx.env"
    log "starting the agent on $target (backend $url)"
    tar -C "$RUN_DIR" -cz agent "agent-s$idx.env" \
      | lab_sh "$target" "rm -rf /var/tmp/$name && mkdir -m 700 /var/tmp/$name && tar -xz -C /var/tmp/$name \
          && systemd-run --quiet --collect --unit=$name --property=WorkingDirectory=/var/tmp/$name/agent \
             --property=EnvironmentFile=/var/tmp/$name/agent-s$idx.env /usr/bin/env node dist/main.js" \
      || die "cannot start the agent on $target"
    for i in $(seq 1 30); do
      lab_sh "$target" "test -s /var/tmp/$name/state/credential" && break
      [[ $i -eq 30 ]] && die "the agent on $target did not enroll (journalctl -u $name on $target)"
      sleep 1
    done
  done
}

# <name> VAR=value... <command...>: detached, with a clean environment and its pid in <name>.pid.
start_detached() {
  local name="$1"; shift
  (
    cd "$RUN_DIR"
    setsid nohup env -i PATH="$PATH" HOME="$HOME" E2E_RUN_ID="$RUN_ID" "$@" \
      >"$RUN_DIR/$name.log" 2>&1 </dev/null &
    echo $! >"$RUN_DIR/$name.pid"
  )
}

wait_ready() {
  local url="$1" i
  for i in $(seq 1 120); do
    curl --silent --fail --max-time 3 "$url" >/dev/null 2>&1 && return 0
    run_owns_pid "$RUN_DIR/backend.pid" || { tail -n 30 "$RUN_DIR/backend.log" >&2; die "backend exited during startup"; }
    sleep 1
  done
  tail -n 30 "$RUN_DIR/backend.log" >&2
  die "$url did not become ready"
}

# lib/bootstrap.ts <phase> with the run's environment.
bootstrap() {
  (
    cd "$E2E_DIR"
    set -a
    # shellcheck disable=SC1091
    source "$RUN_DIR/run.env"
    set +a
    node --import tsx lib/bootstrap.ts "$1"
  )
}

cmd_up() {
  load_lab
  need E2E_PG_URL E2E_SERVERS E2E_BACKEND_PORT E2E_SSH_PROXY_PORT E2E_HTTP_PROXY_PORT \
    E2E_IMAGE_ALIAS E2E_IMAGE_SOURCE_URL E2E_PREFLIGHT_IMAGE_FINGERPRINT E2E_PREFLIGHT_EGRESS_URL \
    E2E_IP_CIDR E2E_IP_ALLOCATION_CIDR E2E_IP_GATEWAY E2E_PROBE_ADDRESS
  need_tools psql openssl curl node pnpm cargo ssh-keygen ssh setsid
  if select_run "" && [[ -e "$RUN_DIR" ]]; then
    die "run $RUN_ID still exists (one run at a time); run \`bash tests/e2e/e2e.sh down\` first"
  fi

  RUN_ID="${E2E_RUN_ID:-$(date +%Y%m%d%H%M%S)-$(openssl rand -hex 2)}"
  select_run "$RUN_ID" || die "E2E_RUN_ID must look like 20260101120000-ab12"
  mkdir -p "$E2E_RUN_ROOT"
  mkdir -m 700 "$RUN_DIR"
  printf '%s\n' "$RUN_ID" >"$E2E_RUN_ROOT/current"
  log "run $RUN_ID in $RUN_DIR"
  trap 'rc=$?; [[ $rc -eq 0 ]] || log "up failed (see $RUN_DIR/*.log); clean up with: bash tests/e2e/e2e.sh down"' EXIT

  if [[ "${E2E_SKIP_BUILD:-0}" != 1 ]]; then
    log "building backend (tsc -b with @nyabase/common) and the Rust proxies"
    (cd "$REPO_ROOT" && pnpm --filter @nyabase/backend build \
      && pnpm --filter @nyabase/agent build \
      && cargo build --release --locked --manifest-path tools/Cargo.toml)
    (cd "$E2E_DIR" && pnpm install --frozen-lockfile --ignore-workspace >/dev/null)
  fi
  local ssh_proxy="$REPO_ROOT/tools/target/release/nyabase-ssh-proxy"
  local http_proxy="$REPO_ROOT/tools/target/release/nyabase-http-proxy"
  [[ -x "$ssh_proxy" && -x "$http_proxy" && -f "$REPO_ROOT/packages/backend/dist/main.js" \
    && -f "$REPO_ROOT/packages/agent/dist/main.js" ]] \
    || die "build outputs are missing (set E2E_SKIP_BUILD=0)"

  log "creating database $DB_NAME"
  pg_admin -c "CREATE DATABASE \"$DB_NAME\""

  local jwt key ssh_token http_token admin_password name idx suffix
  jwt="$(openssl rand -hex 32)"; key="$(openssl rand -hex 32)"
  ssh_token="$(openssl rand -hex 32)"; http_token="$(openssl rand -hex 32)"
  admin_password="$(openssl rand -hex 16)"
  {
    # Sourced by every later step; holds the run's secrets.
    for name in E2E_PG_URL E2E_SERVERS E2E_LISTEN_HOST E2E_SSH_PROXY_PORT E2E_HTTP_PROXY_PORT \
      E2E_IMAGE_ALIAS E2E_IP_CIDR E2E_IP_ALLOCATION_CIDR E2E_IP_GATEWAY E2E_IP_RESERVED \
      E2E_PROBE_ADDRESS E2E_ROOT_SIZE_GIB E2E_SHARED_IDENTITY_KEY E2E_SHARED_CEPH_FSID E2E_SHARED_OVERCOMMIT; do
      printf 'export %s=%q\n' "$name" "${!name:-}"
    done
    for idx in $E2E_SERVERS; do
      for suffix in SSH PARENT DNS POOL SHARED_POOL GPU_PCI RESERVED_CPUS; do
        name="E2E_SERVER_${idx}_${suffix}"
        printf 'export %s=%q\n' "$name" "${!name:-}"
      done
    done
    printf 'export E2E_RUN_ID=%q E2E_RUN_DIR=%q E2E_RUN_ROOT=%q\n' "$RUN_ID" "$RUN_DIR" "$E2E_RUN_ROOT"
    printf 'export E2E_BASE_URL=%q E2E_DATABASE_URL=%q E2E_ADMIN_PASSWORD=%q\n' \
      "http://$E2E_LISTEN_HOST:$E2E_BACKEND_PORT" "$(run_db_url)" "$admin_password"
  } >"$RUN_DIR/run.env"
  chmod 600 "$RUN_DIR/run.env"
  log "starting the backend on $E2E_LISTEN_HOST:$E2E_BACKEND_PORT"
  # NYABASE_CONFIG_FILE points at a file that does not exist so the host's own
  # /etc/nyabase/config.yaml can never leak in; the environment alone configures the run.
  start_detached backend \
    NODE_ENV=production PORT="$E2E_BACKEND_PORT" LISTEN_ADDRESS="$E2E_LISTEN_HOST" \
    NYABASE_CONFIG_FILE="$RUN_DIR/no-config.yaml" DATABASE_URL="$(run_db_url)" \
    JWT_SECRET="$jwt" JWT_EXPIRES_IN=12h SSH_KEY_ENCRYPTION_SECRET="$key" ADMIN_INIT_PASSWORD="$admin_password" \
    SSH_PROXY_TOKEN="$ssh_token" HTTP_PROXY_TOKEN="$http_token" AUTH_COOKIE_SECURE=false \
    SSH_PROXY_PUBLIC_HOST="$E2E_LISTEN_HOST" SSH_PROXY_PUBLIC_PORT="$E2E_SSH_PROXY_PORT" \
    INCUS_PREFLIGHT_IMAGE_ALIAS="$E2E_IMAGE_ALIAS" \
    INCUS_PREFLIGHT_IMAGE_FINGERPRINT="$E2E_PREFLIGHT_IMAGE_FINGERPRINT" \
    INCUS_PREFLIGHT_EGRESS_URL="$E2E_PREFLIGHT_EGRESS_URL" \
    INCUS_PREFLIGHT_SOURCE_SERVER="$E2E_IMAGE_SOURCE_URL" INCUS_IMAGE_SOURCE_URL="$E2E_IMAGE_SOURCE_URL" \
    METRICS_CONTAINER_SERIES_ENABLED=false VICTORIA_METRICS_URL=http://127.0.0.1:1 \
    node "$REPO_ROOT/packages/backend/dist/main.js"
  wait_ready "http://$E2E_LISTEN_HOST:$E2E_BACKEND_PORT/api/health/ready"

  log "starting ssh-proxy on :$E2E_SSH_PROXY_PORT and http-proxy on :$E2E_HTTP_PROXY_PORT"
  start_detached ssh-proxy RUST_LOG=info \
    NYABASE_BACKEND_WS="ws://$E2E_LISTEN_HOST:$E2E_BACKEND_PORT/ws/ssh-proxy" SSH_PROXY_TOKEN="$ssh_token" \
    NYABASE_SSH_LISTEN="$E2E_LISTEN_HOST:$E2E_SSH_PROXY_PORT" "$ssh_proxy"
  start_detached http-proxy RUST_LOG=info \
    NYABASE_BACKEND_WS="ws://$E2E_LISTEN_HOST:$E2E_BACKEND_PORT/ws/http-proxy" HTTP_PROXY_TOKEN="$http_token" \
    NYABASE_HTTP_LISTEN="$E2E_LISTEN_HOST:$E2E_HTTP_PROXY_PORT" "$http_proxy"

  log "registering the lab servers"
  bootstrap servers
  start_agents
  log "registering the rest of the lab (pools, IP pool, shared backend, image, preflight)"
  bootstrap finish
  log "up: run $RUN_ID is ready; \`bash tests/e2e/e2e.sh run\` executes the scenarios"
}
