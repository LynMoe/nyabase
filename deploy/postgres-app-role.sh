#!/usr/bin/env bash
# Creates the Backend's database role and database when they are missing, and
# checks them when they exist. Idempotent: the Compose service
# `postgres-app-role` runs it before every Backend start, and OPERATIONS.md
# runs it by hand (`docker compose run --rm postgres-app-role`). Any problem
# fails the run, so the Backend does not start against a cluster without its
# role instead of failing to log in.
#
# The role owns the `nyabase` database (so it can create its schemas and run
# the migrations) and nothing else: no SUPERUSER, CREATEDB, CREATEROLE,
# REPLICATION or BYPASSRLS. The cluster superuser (POSTGRES_USER, `postgres`)
# is for operators only and is never given to the Backend. An existing role
# keeps its password (rotate it as OPERATIONS.md describes); one with more
# than LOGIN is refused, never altered.
set -euo pipefail

: "${POSTGRES_USER:?POSTGRES_USER is not set}"
: "${NYABASE_DB_PASSWORD:?set NYABASE_DB_PASSWORD in deploy/.env}"
if [[ "$POSTGRES_USER" == nyabase ]]; then
  echo "postgres-app-role: POSTGRES_USER must not be the application role (nyabase)" >&2
  exit 1
fi

# The server's trusted loopback (the service shares the postgres container's
# network namespace); the superuser needs no password there.
export PGHOST="${PGHOST:-127.0.0.1}"

# psql reads the password from its environment (\getenv), so it is never on
# a command line.
psql --no-psqlrc --quiet --set=ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" --dbname postgres <<'SQL'
\getenv app_password NYABASE_DB_PASSWORD
SELECT NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'nyabase') AS create_role \gset
\if :create_role
CREATE ROLE nyabase LOGIN
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  PASSWORD :'app_password';
\echo postgres-app-role: created role nyabase (not a superuser)
\endif
DO $check$
BEGIN
  IF EXISTS (
    SELECT FROM pg_roles
    WHERE rolname = 'nyabase'
      AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls
        OR NOT rolcanlogin)
  ) THEN
    RAISE EXCEPTION 'role nyabase exists with attributes other than LOGIN; it must not be a superuser (see OPERATIONS.md, Database roles)';
  END IF;
END
$check$;
SELECT 'CREATE DATABASE nyabase OWNER nyabase TEMPLATE template0 ENCODING ''UTF8'''
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'nyabase') \gexec
DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT FROM pg_database
    WHERE datname = 'nyabase' AND pg_get_userbyid(datdba) = 'nyabase'
  ) THEN
    RAISE EXCEPTION 'database nyabase is not owned by role nyabase (see OPERATIONS.md, Database roles)';
  END IF;
END
$check$;
SQL
echo "postgres-app-role: role nyabase (not a superuser) owns database nyabase"
