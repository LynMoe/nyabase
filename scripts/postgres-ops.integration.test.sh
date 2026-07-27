#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 0 ]]; then
  echo "Usage: bash scripts/postgres-ops.integration.test.sh" >&2
  exit 2
fi

for command_name in docker; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "required command not found: $command_name" >&2
    exit 1
  }
done

postgres_image='postgres:18.4-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296'
test_root="$(mktemp -d)"
test_suffix="$$"
network_name="nyabase-pg-ops-test-$test_suffix"
server_name="nyabase-pg-ops-test-$test_suffix"
postgres_password='pg-ops-integration-password'

cleanup() {
  local status="$?"
  if [[ "$status" -ne 0 ]]; then
    docker logs --tail 100 "$server_name" >&2 || true
  fi
  docker rm --force "$server_name" >/dev/null 2>&1 || true
  docker network rm "$network_name" >/dev/null 2>&1 || true
  rm -rf "$test_root"
  return "$status"
}
trap cleanup EXIT

docker network create "$network_name" >/dev/null
docker run --detach \
  --name "$server_name" \
  --network "$network_name" \
  --env "POSTGRES_PASSWORD=$postgres_password" \
  "$postgres_image" >/dev/null

for _ in $(seq 1 60); do
  if docker exec \
    --env "PGPASSWORD=$postgres_password" \
    "$server_name" \
    pg_isready --host 127.0.0.1 --username postgres --dbname postgres \
    >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec \
  --env "PGPASSWORD=$postgres_password" \
  "$server_name" \
  pg_isready --host 127.0.0.1 --username postgres --dbname postgres \
  >/dev/null

pg_exec() {
  local database="$1"
  shift
  docker exec \
    --env "PGPASSWORD=$postgres_password" \
    "$server_name" \
    psql --host 127.0.0.1 --username postgres --dbname "$database" \
      --no-psqlrc --set=ON_ERROR_STOP=1 "$@"
}

pg_exec postgres \
  --command='CREATE ROLE restore_owner' \
  --command='CREATE DATABASE source_restore_test TEMPLATE template0 ENCODING '\''UTF8'\''' \
  --command='CREATE DATABASE exact_restore_test OWNER restore_owner TEMPLATE template0 ENCODING '\''UTF8'\''' \
  --command='CREATE DATABASE empty_restore_test OWNER restore_owner TEMPLATE template0 ENCODING '\''UTF8'\'''
pg_exec source_restore_test \
  --command='CREATE TABLE public.restored_marker (id integer PRIMARY KEY, value text NOT NULL)' \
  --command="INSERT INTO public.restored_marker VALUES (1, 'from-archive')"
pg_exec exact_restore_test \
  --command='CREATE SCHEMA legacy' \
  --command='CREATE TABLE legacy.extra (id integer)' \
  --command='INSERT INTO legacy.extra VALUES (42)' \
  --command='CREATE FUNCTION legacy.extra_fn() RETURNS integer LANGUAGE sql AS '\''SELECT 1'\'''

source_url="postgresql://postgres:$postgres_password@$server_name:5432/source_restore_test"
target_url="postgresql://postgres:$postgres_password@$server_name:5432/exact_restore_test"
empty_target_url="postgresql://postgres:$postgres_password@$server_name:5432/empty_restore_test"
maintenance_url="postgresql://postgres:$postgres_password@$server_name:5432/postgres"
original_target_oid="$(
  pg_exec postgres --tuples-only --no-align \
    --command="SELECT oid FROM pg_database WHERE datname = 'exact_restore_test'"
)"

docker run --rm \
  --network "$network_name" \
  --volume "$PWD:/workspace:ro" \
  --volume "$test_root:/artifacts" \
  --env "NYABASE_PG_SOURCE_URL=$source_url" \
  "$postgres_image" \
  bash /workspace/deploy/postgres-ops.sh logical-backup \
    --output /artifacts/source.dump

if docker run --rm \
  --network "$network_name" \
  --volume "$PWD:/workspace:ro" \
  --volume "$test_root:/artifacts" \
  --env "NYABASE_PG_TARGET_URL=$target_url" \
  "$postgres_image" \
  bash /workspace/deploy/postgres-ops.sh restore-logical \
    --input /artifacts/source.dump \
    --confirm-database wrong_database >/dev/null 2>&1; then
  echo "real restore unexpectedly accepted the wrong database confirmation" >&2
  exit 1
fi
[[ "$(
  pg_exec exact_restore_test --tuples-only --no-align \
    --command="SELECT to_regclass('legacy.extra') IS NOT NULL"
)" == "t" ]]

if docker run --rm \
  --network "$network_name" \
  --volume "$PWD:/workspace:ro" \
  --volume "$test_root:/artifacts" \
  --env "NYABASE_PG_TARGET_URL=$maintenance_url" \
  "$postgres_image" \
  bash /workspace/deploy/postgres-ops.sh restore-logical \
    --input /artifacts/source.dump \
    --confirm-database postgres >/dev/null 2>&1; then
  echo "real restore unexpectedly accepted the postgres maintenance database" >&2
  exit 1
fi
[[ "$(
  pg_exec exact_restore_test --tuples-only --no-align \
    --command="SELECT to_regclass('legacy.extra') IS NOT NULL"
)" == "t" ]]

if docker run --rm \
  --network "$network_name" \
  --volume "$PWD:/workspace:ro" \
  --volume "$test_root:/artifacts" \
  --env "NYABASE_PG_TARGET_URL=$target_url" \
  "$postgres_image" \
  bash /workspace/deploy/postgres-ops.sh restore-logical \
    --input /artifacts/source.dump \
    --confirm-database exact_restore_test >/dev/null 2>&1; then
  echo "real restore unexpectedly accepted a non-empty target" >&2
  exit 1
fi

[[ "$(
  pg_exec exact_restore_test --tuples-only --no-align \
    --command="SELECT
      to_regclass('legacy.extra') IS NOT NULL
      AND to_regprocedure('legacy.extra_fn()') IS NOT NULL
      AND (SELECT id FROM legacy.extra) = 42"
)" == "t" ]]
[[ "$(
  pg_exec postgres --tuples-only --no-align \
    --command="SELECT oid FROM pg_database WHERE datname = 'exact_restore_test'"
)" == "$original_target_oid" ]]

docker run --rm \
  --network "$network_name" \
  --volume "$PWD:/workspace:ro" \
  --volume "$test_root:/artifacts" \
  --env "NYABASE_PG_TARGET_URL=$empty_target_url" \
  "$postgres_image" \
  bash /workspace/deploy/postgres-ops.sh restore-logical \
    --input /artifacts/source.dump \
    --confirm-database empty_restore_test

[[ "$(
  pg_exec empty_restore_test --tuples-only --no-align \
    --command="SELECT
      (SELECT value FROM public.restored_marker WHERE id = 1) = 'from-archive'"
)" == "t" ]]
[[ "$(
  pg_exec postgres --tuples-only --no-align \
    --command="SELECT
      pg_get_userbyid(datdba) = 'restore_owner'
      AND pg_encoding_to_char(encoding) = 'UTF8'
      FROM pg_database
      WHERE datname = 'empty_restore_test'"
)" == "t" ]]

# The 16 MiB default has 256 segments per 4 GiB WAL log ID. Prove that the
# comparator treats ...00FF -> ...0100000000 as forward progress across wrap.
[[ "$(
  pg_exec postgres --tuples-only --no-align \
    --command="SELECT (
      ('x' || substr('000000010000000100000000', 9, 8))::bit(32)::bigint
        * (4294967296 / pg_size_bytes('16MB'))
      + ('x' || substr('000000010000000100000000', 17, 8))::bit(32)::bigint
    ) > (
      ('x' || substr('0000000100000000000000FF', 9, 8))::bit(32)::bigint
        * (4294967296 / pg_size_bytes('16MB'))
      + ('x' || substr('0000000100000000000000FF', 17, 8))::bit(32)::bigint
    )"
)" == "t" ]]

echo "real PostgreSQL fresh-only logical restore and WAL ordering tests passed"
