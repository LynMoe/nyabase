#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage:
  postgres-ops.sh logical-backup --output FILE [--source-env NAME]
  postgres-ops.sh verify-logical --input FILE
  postgres-ops.sh restore-logical --input FILE --confirm-database NAME [--target-env NAME]
  postgres-ops.sh base-backup --output-dir DIR [--source-env NAME]
  postgres-ops.sh verify-base --input-dir DIR
  postgres-ops.sh pitr-archive-probe --output FILE [--source-env NAME] [--timeout-seconds N]
  postgres-ops.sh upgrade-preflight --target-major MAJOR --output FILE [--source-env NAME]

Connection strings are read indirectly from environment variables so secrets do
not appear in shell history. Defaults:
  source: NYABASE_PG_SOURCE_URL
  target: NYABASE_PG_TARGET_URL
EOF
  exit 2
}

die() {
  echo "postgres-ops: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

require_regular_input() {
  local input_path="$1"
  [[ -f "$input_path" && ! -L "$input_path" ]] \
    || die "input must be a regular, non-symlink file: $input_path"
}

require_new_output() {
  local output_path="$1"
  [[ "$output_path" != "/" ]] || die "refusing filesystem root as output"
  [[ ! -e "$output_path" && ! -L "$output_path" ]] \
    || die "output already exists: $output_path"
  [[ -d "$(dirname "$output_path")" ]] \
    || die "output parent directory does not exist: $(dirname "$output_path")"
}

connection_from_env() {
  local variable_name="$1"
  [[ "$variable_name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] \
    || die "invalid connection environment variable name"
  local connection="${!variable_name:-}"
  [[ -n "$connection" ]] || die "connection environment variable is empty: $variable_name"
  printf '%s' "$connection"
}

verify_checksum() {
  local input_path="$1"
  local checksum_path="${input_path}.sha256"
  require_regular_input "$checksum_path"
  (
    cd "$(dirname "$input_path")"
    sha256sum --check --status "$(basename "$checksum_path")"
  ) || die "checksum verification failed: $input_path"
}

mode="${1:-}"
[[ -n "$mode" ]] || usage
shift

source_env="NYABASE_PG_SOURCE_URL"
target_env="NYABASE_PG_TARGET_URL"
output=""
output_dir=""
input=""
input_dir=""
confirm_database=""
target_major=""
timeout_seconds="60"

while (($#)); do
  case "$1" in
    --source-env) source_env="${2:-}"; shift 2 ;;
    --target-env) target_env="${2:-}"; shift 2 ;;
    --output) output="${2:-}"; shift 2 ;;
    --output-dir) output_dir="${2:-}"; shift 2 ;;
    --input) input="${2:-}"; shift 2 ;;
    --input-dir) input_dir="${2:-}"; shift 2 ;;
    --confirm-database) confirm_database="${2:-}"; shift 2 ;;
    --target-major) target_major="${2:-}"; shift 2 ;;
    --timeout-seconds) timeout_seconds="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

case "$mode" in
  logical-backup)
    [[ -n "$output" ]] || usage
    require_command pg_dump
    require_command pg_restore
    require_command sha256sum
    require_new_output "$output"
    require_new_output "${output}.sha256"
    source_connection="$(connection_from_env "$source_env")"
    output_parent="$(dirname "$output")"
    output_name="$(basename "$output")"
    partial_output="$output_parent/.${output_name}.partial.$$"
    partial_checksum="$output_parent/.${output_name}.sha256.partial.$$"
    cleanup_partial_backup() {
      if [[ "${published_output:-false}" == true ]]; then
        rm -f -- "$output"
      fi
      rm -f -- "$partial_output" "$partial_checksum"
    }
    trap cleanup_partial_backup EXIT
    umask 077
    pg_dump --dbname="$source_connection" \
      --format=custom \
      --compress=9 \
      --no-owner \
      --no-privileges \
      --file="$partial_output"
    pg_restore --list "$partial_output" >/dev/null
    checksum="$(sha256sum "$partial_output" | awk '{print $1}')"
    printf '%s  %s\n' "$checksum" "$output_name" >"$partial_checksum"
    # Both files are built and verified in the destination filesystem. Publish
    # the archive first and its sidecar immediately afterward; the verifier
    # rejects either an absent sidecar or any mismatched/partial archive.
    published_output=false
    ln -- "$partial_output" "$output" \
      || die "output appeared while backup was running: $output"
    published_output=true
    rm -f -- "$partial_output"
    ln -- "$partial_checksum" "${output}.sha256" \
      || die "checksum output appeared while backup was running: ${output}.sha256"
    rm -f -- "$partial_checksum"
    published_output=false
    trap - EXIT
    echo "logical backup created and verified: $output"
    ;;

  verify-logical)
    [[ -n "$input" ]] || usage
    require_command pg_restore
    require_command sha256sum
    require_regular_input "$input"
    verify_checksum "$input"
    pg_restore --list "$input" >/dev/null
    echo "logical backup verified: $input"
    ;;

  restore-logical)
    [[ -n "$input" && -n "$confirm_database" ]] || usage
    require_command psql
    require_command pg_restore
    require_command sha256sum
    require_regular_input "$input"
    verify_checksum "$input"
    pg_restore --list "$input" >/dev/null
    target_connection="$(connection_from_env "$target_env")"
    actual_database="$(
      psql --dbname="$target_connection" \
        --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 \
        --command='SELECT current_database()'
    )"
    [[ "$actual_database" == "$confirm_database" ]] \
      || die "target database confirmation mismatch"
    [[ "$actual_database" != "postgres" && "$actual_database" != "template0" && "$actual_database" != "template1" ]] \
      || die "refusing to restore into a PostgreSQL maintenance database"
    user_objects="$(
      psql --dbname="$target_connection" \
        --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 \
        --command="SELECT
          (
            SELECT count(*)
            FROM pg_namespace
            WHERE nspname NOT LIKE 'pg_%'
              AND nspname NOT IN ('information_schema', 'public')
          )
          +
          (
            SELECT count(*)
            FROM pg_class AS relation
            JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'public'
              AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
          )
          +
          (
            SELECT count(*)
            FROM pg_proc AS routine
            JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
            WHERE namespace.nspname = 'public'
          )
          +
          (
            SELECT count(*)
            FROM pg_type AS type
            JOIN pg_namespace AS namespace ON namespace.oid = type.typnamespace
            WHERE namespace.nspname = 'public'
          )"
    )"
    [[ "$user_objects" == "0" ]] \
      || die "target is not empty; restore requires a separately provisioned empty database"
    restore_args=(--exit-on-error --no-owner --no-privileges)
    pg_restore --dbname="$target_connection" "${restore_args[@]}" "$input"
    psql --dbname="$target_connection" \
      --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 \
      --command='SELECT 1' >/dev/null
    echo "logical backup restored into confirmed database: $actual_database"
    ;;

  base-backup)
    [[ -n "$output_dir" ]] || usage
    require_command pg_basebackup
    require_command pg_verifybackup
    require_new_output "$output_dir"
    source_connection="$(connection_from_env "$source_env")"
    output_parent="$(dirname "$output_dir")"
    output_name="$(basename "$output_dir")"
    partial_output_dir="$output_parent/.${output_name}.partial.$$"
    cleanup_partial_base_backup() {
      rm -rf -- "$partial_output_dir"
    }
    trap cleanup_partial_base_backup EXIT
    umask 077
    pg_basebackup --dbname="$source_connection" \
      --pgdata="$partial_output_dir" \
      --format=plain \
      --wal-method=stream \
      --checkpoint=fast \
      --manifest-checksums=SHA256 \
      --progress
    pg_verifybackup "$partial_output_dir"
    mv -- "$partial_output_dir" "$output_dir"
    trap - EXIT
    echo "physical base backup created and verified: $output_dir"
    ;;

  verify-base)
    [[ -n "$input_dir" ]] || usage
    require_command pg_verifybackup
    [[ -d "$input_dir" && ! -L "$input_dir" ]] \
      || die "input must be a directory, not a symlink: $input_dir"
    [[ -f "$input_dir/backup_manifest" ]] \
      || die "backup_manifest is missing: $input_dir"
    pg_verifybackup "$input_dir"
    echo "physical base backup verified: $input_dir"
    ;;

  pitr-archive-probe)
    [[ -n "$output" ]] || usage
    [[ "$timeout_seconds" =~ ^[0-9]+$ ]] \
      || die "timeout seconds must be numeric"
    (( timeout_seconds >= 1 && timeout_seconds <= 600 )) \
      || die "timeout seconds must be between 1 and 600"
    require_command psql
    require_new_output "$output"
    source_connection="$(connection_from_env "$source_env")"
    psql_scalar() {
      psql --dbname="$source_connection" \
        --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 \
        --command="$1"
    }
    archive_mode="$(psql_scalar 'SHOW archive_mode')"
    archive_command="$(psql_scalar 'SHOW archive_command')"
    archive_library="$(psql_scalar 'SHOW archive_library')"
    [[ "$archive_mode" == "on" || "$archive_mode" == "always" ]] \
      || die "archive_mode must be on or always"
    if [[ -z "$archive_library" ]]; then
      [[ -n "$archive_command" && "$archive_command" != "(disabled)" ]] \
        || die "archive_command or archive_library must be configured"
    fi
    initial_failed_count="$(psql_scalar \
      'SELECT failed_count FROM pg_stat_archiver')"
    initial_last_failed_wal="$(psql_scalar \
      "SELECT COALESCE(last_failed_wal, '') FROM pg_stat_archiver")"
    [[ "$initial_failed_count" =~ ^[0-9]+$ ]] \
      || die "unexpected initial archiver failure count"
    [[ -z "$initial_last_failed_wal" || "$initial_last_failed_wal" =~ ^[0-9A-F]{24}$ ]] \
      || die "unexpected initial failed WAL segment name"
    wal_segment="$(
      psql_scalar 'SELECT pg_walfile_name(pg_switch_wal())'
    )"
    [[ "$wal_segment" =~ ^[0-9A-F]{24}$ ]] \
      || die "unexpected WAL segment name"
    deadline="$((SECONDS + timeout_seconds))"
    archived=false
    last_archived_wal=""
    final_failed_count="$initial_failed_count"
    final_last_failed_wal="$initial_last_failed_wal"
    last_archived_time=""
    while (( SECONDS < deadline )); do
      archive_state="$(
        psql_scalar "WITH params AS (
          SELECT
            pg_size_bytes(current_setting('wal_segment_size'))::bigint AS segment_size,
            '$wal_segment'::text AS target_wal
        ),
        observed AS (
          SELECT
            last_archived_wal,
            failed_count,
            COALESCE(last_failed_wal, '') AS last_failed_wal,
            COALESCE(
              (last_archived_time AT TIME ZONE 'UTC')::text,
              ''
            ) AS last_archived_time_utc
          FROM pg_stat_archiver
        ),
        compared AS (
          SELECT
            params.*,
            observed.*,
            CASE
              WHEN observed.last_archived_wal ~ '^[0-9A-F]{24}$'
              THEN ('x' || substr(observed.last_archived_wal, 9, 8))::bit(32)::bigint
            END AS archived_log,
            CASE
              WHEN observed.last_archived_wal ~ '^[0-9A-F]{24}$'
              THEN ('x' || substr(observed.last_archived_wal, 17, 8))::bit(32)::bigint
            END AS archived_segment,
            ('x' || substr(params.target_wal, 9, 8))::bit(32)::bigint AS target_log,
            ('x' || substr(params.target_wal, 17, 8))::bit(32)::bigint AS target_segment
          FROM params CROSS JOIN observed
        )
        SELECT
          CASE
            WHEN failed_count > $initial_failed_count THEN 'failed'
            WHEN failed_count < $initial_failed_count
              OR (
                failed_count = $initial_failed_count
                AND last_failed_wal IS DISTINCT FROM '$initial_last_failed_wal'
              ) THEN 'stats-reset'
            WHEN last_archived_wal IS NULL THEN 'pending'
            WHEN last_archived_wal !~ '^[0-9A-F]{24}$' THEN 'invalid'
            WHEN substr(last_archived_wal, 1, 8) <> substr(target_wal, 1, 8)
              THEN 'timeline-mismatch'
            WHEN (
              archived_log * (4294967296 / segment_size) + archived_segment
            ) >= (
              target_log * (4294967296 / segment_size) + target_segment
            ) THEN 'archived'
            ELSE 'pending'
          END
          || '|' || COALESCE(last_archived_wal, '')
          || '|' || failed_count::text
          || '|' || last_failed_wal
          || '|' || last_archived_time_utc
        FROM compared"
      )"
      IFS='|' read -r archive_status last_archived_wal \
        final_failed_count final_last_failed_wal last_archived_time \
        <<<"$archive_state"
      [[ "$final_failed_count" =~ ^[0-9]+$ ]] \
        || die "unexpected archiver failure count"
      [[ -z "$final_last_failed_wal" || "$final_last_failed_wal" =~ ^[0-9A-F]{24}$ ]] \
        || die "unexpected failed WAL segment name"
      case "$archive_status" in
        archived)
          archived=true
          break
          ;;
        pending)
          ;;
        failed)
          die "WAL archiver failure count increased while probing (last_failed_wal=${final_last_failed_wal:-none})"
          ;;
        invalid)
          die "archiver reported an invalid WAL segment name"
          ;;
        timeline-mismatch)
          die "archiver advanced on a different WAL timeline; exact target ordering is unprovable"
          ;;
        stats-reset)
          die "archiver failure statistics changed non-monotonically while probing"
          ;;
        *)
          die "unexpected WAL archive probe state"
          ;;
      esac
      sleep 1
    done
    [[ "$archived" == true ]] \
      || die "WAL archive did not reach segment within ${timeout_seconds}s"
    umask 077
    {
      echo "archive_mode=$archive_mode"
      echo "archive_transport=$([[ -n "$archive_library" ]] && echo library || echo command)"
      echo "wal_segment=$wal_segment"
      echo "last_archived_wal=$last_archived_wal"
      echo "last_archived_time_utc=$last_archived_time"
      echo "historical_failed_count=$initial_failed_count"
      echo "historical_last_failed_wal=$initial_last_failed_wal"
      echo "final_failed_count=$final_failed_count"
      echo "final_last_failed_wal=$final_last_failed_wal"
      echo "result=pass"
    } >"$output"
    echo "PITR WAL archive probe passed: $output"
    ;;

  upgrade-preflight)
    [[ -n "$target_major" && -n "$output" ]] || usage
    [[ "$target_major" =~ ^[0-9]+$ ]] || die "target major must be numeric"
    require_command psql
    require_command pg_dump
    require_new_output "$output"
    source_connection="$(connection_from_env "$source_env")"
    server_version_num="$(
      psql --dbname="$source_connection" \
        --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 \
        --command='SHOW server_version_num'
    )"
    [[ "$server_version_num" =~ ^[0-9]+$ ]] || die "unexpected server_version_num"
    source_major="$((server_version_num / 10000))"
    client_version="$(
      pg_dump --version | sed -E 's/.* ([0-9]+)(\..*)?$/\1/'
    )"
    [[ "$client_version" =~ ^[0-9]+$ ]] || die "unable to determine pg_dump major"
    (( target_major >= source_major )) \
      || die "target major must not be older than source major"
    (( client_version >= source_major )) \
      || die "pg_dump client is older than the source server"
    pg_dump --dbname="$source_connection" \
      --schema-only --no-owner --no-privileges --file=/dev/null
    database_name="$(
      psql --dbname="$source_connection" \
        --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 \
        --command='SELECT current_database()'
    )"
    invalid_indexes="$(
      psql --dbname="$source_connection" \
        --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 \
        --command='SELECT count(*) FROM pg_index WHERE NOT indisvalid'
    )"
    prepared_transactions="$(
      psql --dbname="$source_connection" \
        --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 \
        --command='SELECT count(*) FROM pg_prepared_xacts'
    )"
    [[ "$invalid_indexes" == "0" ]] || die "source has invalid indexes"
    [[ "$prepared_transactions" == "0" ]] || die "source has prepared transactions"
    umask 077
    {
      echo "database=$database_name"
      echo "source_major=$source_major"
      echo "target_major=$target_major"
      echo "pg_dump_major=$client_version"
      echo "invalid_indexes=$invalid_indexes"
      echo "prepared_transactions=$prepared_transactions"
      echo "schema_dump=ok"
      echo "result=pass"
    } >"$output"
    echo "upgrade preflight passed: $output"
    ;;

  *) usage ;;
esac
