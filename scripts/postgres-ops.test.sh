#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 0 ]]; then
  echo "Usage: bash scripts/postgres-ops.test.sh" >&2
  exit 2
fi

test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT
fake_bin="$test_root/bin"
mkdir -p "$fake_bin" "$test_root/out"

make_fake() {
  local name="$1"
  local body="$2"
  {
    echo '#!/usr/bin/env bash'
    echo 'set -euo pipefail'
    printf '%s\n' "$body"
  } >"$fake_bin/$name"
  chmod 0755 "$fake_bin/$name"
}

make_fake pg_dump '
if [[ "${1:-}" == "--version" ]]; then echo "pg_dump (PostgreSQL) 18.4"; exit 0; fi
output=""
for argument in "$@"; do
  [[ "$argument" == --file=* ]] && output="${argument#--file=}"
done
[[ "$output" == "/dev/null" ]] && exit 0
printf "fake-custom-backup" >"$output"
if [[ "${FAIL_PG_DUMP:-0}" == 1 ]]; then exit 9; fi
'
make_fake pg_restore '
[[ "${1:-}" == "--list" ]] && { [[ -f "$2" ]]; exit; }
exit 0
'
make_fake pg_basebackup '
output=""
for argument in "$@"; do
  [[ "$argument" == --pgdata=* ]] && output="${argument#--pgdata=}"
done
mkdir "$output"
printf "{}" >"$output/backup_manifest"
'
make_fake pg_verifybackup '
[[ -f "$1/backup_manifest" ]]
'
make_fake psql '
query=""
while (($#)); do
  if [[ "$1" == "--command="* ]]; then
    query="${1#--command=}"
  fi
  shift
done
case "$query" in
  "SHOW server_version_num") echo 180004 ;;
  "SHOW archive_mode") echo on ;;
  "SHOW archive_command") echo "archive-command-present" ;;
  "SHOW archive_library") echo "" ;;
  "SELECT current_database()") echo "${FAKE_CURRENT_DATABASE:-nyabase_restore}" ;;
  "SELECT pg_walfile_name(pg_switch_wal())") echo 000000010000000000000001 ;;
  "SELECT failed_count FROM pg_stat_archiver") echo 0 ;;
  "SELECT COALESCE(last_failed_wal, '"'"''"'"') FROM pg_stat_archiver") echo "" ;;
  *"WITH params AS"*)
    case "${FAKE_ARCHIVE_STATE:-advanced}" in
      advanced)
        printf "archived|000000010000000000000002|0||2026-07-27 00:00:00\\n"
        ;;
      timeline)
        printf "timeline-mismatch|000000020000000000000001|0||2026-07-27 00:00:00\\n"
        ;;
      failure)
        printf "failed|000000010000000000000001|1|000000010000000000000001|2026-07-27 00:00:00\\n"
        ;;
      stats-reset)
        printf "stats-reset|000000010000000000000001|0|000000010000000000000000|2026-07-27 00:00:00\\n"
        ;;
      *) exit 1 ;;
    esac
    ;;
  *"relkind IN"*) echo "${FAKE_USER_OBJECTS:-0}" ;;
  *"pg_namespace"*) echo 1 ;;
  *"pg_index"*) echo 0 ;;
  *"pg_prepared_xacts"*) echo 0 ;;
  "SELECT 1") echo 1 ;;
  *) exit 1 ;;
esac
'

export PATH="$fake_bin:$PATH"
export NYABASE_PG_SOURCE_URL='postgresql://source.invalid/nyabase'
export NYABASE_PG_TARGET_URL='postgresql://target.invalid/nyabase_restore'
ops="deploy/postgres-ops.sh"

bash "$ops" logical-backup --output "$test_root/out/nyabase.dump"
bash "$ops" verify-logical --input "$test_root/out/nyabase.dump"
if FAIL_PG_DUMP=1 bash "$ops" logical-backup \
  --output "$test_root/out/failed.dump" 2>/dev/null; then
  echo "failing logical backup unexpectedly succeeded" >&2
  exit 1
fi
if find "$test_root/out" -maxdepth 1 -name '*failed.dump*' -print -quit | grep -q .; then
  echo "failing logical backup left a partial artifact" >&2
  exit 1
fi
if bash "$ops" logical-backup --output "$test_root/out/nyabase.dump" 2>/dev/null; then
  echo "logical backup unexpectedly overwrote an existing target" >&2
  exit 1
fi
if bash "$ops" restore-logical \
  --input "$test_root/out/nyabase.dump" \
  --confirm-database wrong_database 2>/dev/null; then
  echo "restore unexpectedly accepted the wrong target confirmation" >&2
  exit 1
fi
if FAKE_CURRENT_DATABASE=postgres bash "$ops" restore-logical \
  --input "$test_root/out/nyabase.dump" \
  --confirm-database postgres 2>/dev/null; then
  echo "restore unexpectedly accepted a maintenance database" >&2
  exit 1
fi
bash "$ops" restore-logical \
  --input "$test_root/out/nyabase.dump" \
  --confirm-database nyabase_restore
if FAKE_USER_OBJECTS=1 bash "$ops" restore-logical \
  --input "$test_root/out/nyabase.dump" \
  --confirm-database nyabase_restore 2>/dev/null; then
  echo "restore unexpectedly accepted a non-empty target" >&2
  exit 1
fi
bash "$ops" base-backup --output-dir "$test_root/out/base"
bash "$ops" verify-base --input-dir "$test_root/out/base"
bash "$ops" pitr-archive-probe \
  --output "$test_root/out/pitr-archive-probe.txt" \
  --timeout-seconds 2
grep -qx 'result=pass' "$test_root/out/pitr-archive-probe.txt"
grep -qx 'last_archived_wal=000000010000000000000002' \
  "$test_root/out/pitr-archive-probe.txt"
if FAKE_ARCHIVE_STATE=timeline bash "$ops" pitr-archive-probe \
  --output "$test_root/out/pitr-timeline-failure.txt" \
  --timeout-seconds 2 2>/dev/null; then
  echo "PITR probe unexpectedly compared WAL across timelines" >&2
  exit 1
fi
[[ ! -e "$test_root/out/pitr-timeline-failure.txt" ]]
if FAKE_ARCHIVE_STATE=failure bash "$ops" pitr-archive-probe \
  --output "$test_root/out/pitr-archiver-failure.txt" \
  --timeout-seconds 2 2>/dev/null; then
  echo "PITR probe unexpectedly ignored a new archiver failure" >&2
  exit 1
fi
[[ ! -e "$test_root/out/pitr-archiver-failure.txt" ]]
if FAKE_ARCHIVE_STATE=stats-reset bash "$ops" pitr-archive-probe \
  --output "$test_root/out/pitr-stats-reset.txt" \
  --timeout-seconds 2 2>/dev/null; then
  echo "PITR probe unexpectedly ignored an archiver statistics reset" >&2
  exit 1
fi
[[ ! -e "$test_root/out/pitr-stats-reset.txt" ]]
bash "$ops" upgrade-preflight \
  --target-major 18 \
  --output "$test_root/out/upgrade-preflight.txt"
grep -qx 'result=pass' "$test_root/out/upgrade-preflight.txt"

echo "postgres operations contract tests passed"
