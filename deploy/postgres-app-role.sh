#!/usr/bin/env bash
# Creates the Backend's database role and database. The postgres image runs
# this once, from /docker-entrypoint-initdb.d, on the first start of an empty
# data volume; OPERATIONS.md also runs it by hand when moving an existing
# installation off the superuser.
#
# The role owns the `nyabase` database (so it can create its schemas and run
# the migrations) and nothing else: no SUPERUSER, CREATEDB, CREATEROLE,
# REPLICATION or BYPASSRLS. The cluster superuser (POSTGRES_USER, `postgres`)
# is for operators only and is never given to the Backend.
#
# A subshell, because the image sources (rather than executes) an init script
# that lost its executable bit, and the shell options must not leak into it.
(
  set -euo pipefail

  : "${POSTGRES_USER:?POSTGRES_USER is not set}"
  : "${NYABASE_DB_PASSWORD:?set NYABASE_DB_PASSWORD in deploy/.env}"
  if [[ "$POSTGRES_USER" == nyabase ]]; then
    echo "postgres-app-role: POSTGRES_USER must not be the application role (nyabase)" >&2
    exit 1
  fi

  # psql reads the password from its environment (\getenv), so it is never on
  # a command line.
  psql --no-psqlrc --quiet --set=ON_ERROR_STOP=1 \
    --username "$POSTGRES_USER" --dbname postgres <<'SQL'
\getenv app_password NYABASE_DB_PASSWORD
CREATE ROLE nyabase LOGIN
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  PASSWORD :'app_password';
CREATE DATABASE nyabase OWNER nyabase TEMPLATE template0 ENCODING 'UTF8';
SQL
  echo "postgres-app-role: created role nyabase (not a superuser) and database nyabase"
)
