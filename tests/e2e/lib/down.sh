#!/usr/bin/env bash
# `e2e.sh down [run-id]`: stop the processes, remove from every lab host only
# what this run created, drop the database, delete the run directory. Safe to
# repeat and to run after a partial `up`: whatever the database knew is saved to
# $RUN_DIR/resources.tsv first, and the run directory is only removed when
# every host was swept cleanly.

# One query against the run's database; a missing database or table yields nothing.
run_query() { psql "$(run_db_url)" -X -q -A -t -F $'\t' -v ON_ERROR_STOP=1 -c "$1" 2>/dev/null || true; }

# Merges what the run's database knows (if it still exists) into resources.tsv:
#   client <fingerprint>  |  server <slug> <id>  |  container <slug> <instance>
#   volume <slug> <pool> <volume>
record_resources() {
  local file="$RUN_DIR/resources.tsv" tmp
  tmp="$(mktemp)"
  {
    [[ -f "$file" ]] && cat "$file"
    run_query "SELECT 'client', lower(replace(fingerprint, ':', '')) FROM system.incus_client_identity"
    run_query "SELECT 'server', slug, id FROM infra.servers"
    run_query "SELECT 'container', s.slug, c.instance_name FROM control.containers c
                 JOIN infra.servers s ON s.id = c.server_id WHERE c.instance_name IS NOT NULL"
    run_query "SELECT 'volume', s.slug, p.incus_name, v.incus_name FROM control.volumes v
                 JOIN infra.servers s ON s.id = v.server_id JOIN infra.storage_pools p ON p.id = v.pool_id
                 WHERE v.server_id IS NOT NULL"
    run_query "SELECT 'volume', s.slug, p.incus_name, v.incus_name FROM control.volume_placements vp
                 JOIN control.volumes v ON v.id = vp.volume_id JOIN infra.servers s ON s.id = vp.server_id
                 JOIN infra.storage_pools p ON p.id = vp.pool_id"
    true
  } | sort -u >"$tmp"
  mv "$tmp" "$file"
}

cmd_down() {
  load_lab
  need E2E_PG_URL
  need_tools psql ssh
  if ! select_run "${1:-}"; then
    log "no run to tear down"
    return 0
  fi
  [[ -d "$RUN_DIR" ]] || { log "run $RUN_ID has no directory; dropping its database only"; mkdir -p -m 700 "$RUN_DIR"; }
  log "tearing down run $RUN_ID"

  stop_run_process "$RUN_DIR/http-proxy.pid"
  stop_run_process "$RUN_DIR/ssh-proxy.pid"
  stop_run_process "$RUN_DIR/backend.pid"

  record_resources
  local failed=0 idx var target slug sid token fp instances volumes
  fp="$(awk -F'\t' '$1 == "client" { print $2; exit }' "$RUN_DIR/resources.tsv" 2>/dev/null || true)"
  # Servers that share a host are swept once per host entry; each uses its own server id.
  for idx in ${E2E_SERVERS:-}; do
    [[ "$idx" =~ ^[0-9]+$ ]] || continue
    var="E2E_SERVER_${idx}_SSH"; target="${!var:-}"
    [[ -n "$target" ]] || continue
    slug="e2e-$RUN_ID-s$idx"
    sid="$(awk -F'\t' -v s="$slug" '$1 == "server" && $2 == s { print $3; exit }' "$RUN_DIR/resources.tsv" 2>/dev/null || true)"
    token="nyabase-e2e-$RUN_ID-s$idx"
    instances="$(awk -F'\t' -v s="$slug" '$1 == "container" && $2 == s { printf "%s%s", sep, $3; sep = "," }' "$RUN_DIR/resources.tsv")"
    volumes="$(awk -F'\t' -v s="$slug" '$1 == "volume" && $2 == s { printf "%s%s/%s", sep, $3, $4; sep = "," }' "$RUN_DIR/resources.tsv")"
    if [[ -z "$sid" ]]; then
      # The server never got registered, so no instance or volume can carry its id.
      sid="00000000-0000-0000-0000-000000000000"
    fi
    log "sweeping $target (server $slug ${sid})"
    if ! lab_bash "$target" "$sid" "${fp:--}" "$token" "${instances:--}" "${volumes:--}" <"$E2E_DIR/lib/lab-sweep.sh"; then
      log "sweep of $target failed; resources stay recorded in $RUN_DIR/resources.tsv"
      failed=1
    fi
  done
  if [[ "$failed" -ne 0 ]]; then
    die "some lab hosts could not be cleaned; fix them and re-run \`e2e.sh down $RUN_ID\` (database and run directory are kept)"
  fi

  log "dropping database $DB_NAME"
  pg_admin -c "DROP DATABASE IF EXISTS \"$DB_NAME\" WITH (FORCE)"
  rm -rf "$RUN_DIR"
  if [[ -f "$E2E_RUN_ROOT/current" && "$(<"$E2E_RUN_ROOT/current")" == "$RUN_ID" ]]; then
    rm -f "$E2E_RUN_ROOT/current"
  fi
  log "down: run $RUN_ID removed"
}
