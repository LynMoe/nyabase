#!/usr/bin/env bash
# Scheduled logical backup of the Compose PostgreSQL: run by
# nyabase-backup.service (installed as /usr/local/sbin/nyabase-backup), or by
# hand as root. It takes and verifies one archive with postgres-ops.sh, hands
# it to an optional off-host upload command, and then deletes local archives
# older than the retention.
#
# The dump runs in a throwaway container from the running server's image,
# joined to the postgres container's network namespace: it connects over the
# container's loopback (trusted), so no password file is involved. It holds
# ciphertext of the encrypted keys but none of the secrets in config.yaml,
# which are kept elsewhere (OPERATIONS.md, "Secrets are not in the backup").
#
# Environment (/etc/nyabase/backup.env):
#   NYABASE_DEPLOY_DIR             checkout's deploy/ directory (postgres-ops.sh)
#   NYABASE_BACKUP_ROOT            local archive directory (/srv/nyabase-backups),
#                                  mode 0700, owned by the operator who runs pg_ops
#   NYABASE_BACKUP_KEEP_DAYS       delete local archives older than this (14)
#   NYABASE_BACKUP_UPLOAD_COMMAND  optional executable, called with the archive
#                                  and its .sha256; a failure fails the run
#   NYABASE_COMPOSE_PROJECT        Compose project name (nyabase)
set -euo pipefail

die() {
  echo "nyabase-backup: $*" >&2
  exit 1
}

deploy_dir=${NYABASE_DEPLOY_DIR:-/opt/nyabase/deploy}
backup_root=${NYABASE_BACKUP_ROOT:-/srv/nyabase-backups}
keep_days=${NYABASE_BACKUP_KEEP_DAYS:-14}
upload=${NYABASE_BACKUP_UPLOAD_COMMAND:-}
project=${NYABASE_COMPOSE_PROJECT:-nyabase}

[[ "$keep_days" =~ ^[0-9]+$ ]] && ((keep_days >= 1)) \
  || die "NYABASE_BACKUP_KEEP_DAYS must be a whole number of days, at least 1"
ops_script="$deploy_dir/postgres-ops.sh"
[[ -f "$ops_script" ]] || die "postgres-ops.sh not found in NYABASE_DEPLOY_DIR=$deploy_dir"
[[ -d "$backup_root" && ! -L "$backup_root" ]] \
  || die "NYABASE_BACKUP_ROOT is not a directory: $backup_root"
if [[ -n "$upload" ]]; then
  [[ -x "$upload" ]] || die "NYABASE_BACKUP_UPLOAD_COMMAND is not executable: $upload"
fi
command -v docker >/dev/null 2>&1 || die "docker not found"

mapfile -t containers < <(
  docker ps --quiet \
    --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=postgres"
)
((${#containers[@]} == 1)) \
  || die "expected one running postgres container in Compose project $project, found ${#containers[@]}"
container=${containers[0]}
image=$(docker inspect --format '{{.Config.Image}}' "$container")

umask 077
name="nyabase-$(date -u +%Y%m%dT%H%M%SZ).dump"
# Every archive in the staging directory belongs to its owner, the operator
# account that also runs pg_ops by hand (OPERATIONS.md, "Backup and restore
# contract"), so hand-run verifications and restores can read these. Without
# capabilities nobody else may write there anyway.
docker run --rm \
  --network "container:$container" \
  --user "$(stat -c '%u:%g' "$backup_root")" \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --volume "$ops_script:/opt/nyabase/postgres-ops.sh:ro" \
  --volume "$backup_root:/backups" \
  --env NYABASE_PG_SOURCE_URL=postgresql://nyabase@127.0.0.1:5432/nyabase \
  "$image" \
  bash -c 'bash /opt/nyabase/postgres-ops.sh logical-backup --output "/backups/$1" &&
    bash /opt/nyabase/postgres-ops.sh verify-logical --input "/backups/$1"' \
  _ "$name"

archive="$backup_root/$name"
if [[ -n "$upload" ]]; then
  "$upload" "$archive" "$archive.sha256" || die "upload command failed for $archive"
fi

# Retention applies to local copies only, and only after a verified backup.
while IFS= read -r -d '' old; do
  rm -f -- "$old" "$old.sha256"
  echo "nyabase-backup: removed $old (older than $keep_days days)"
done < <(find "$backup_root" -maxdepth 1 -type f -name 'nyabase-*.dump' \
  -mtime "+$keep_days" -print0)
# A run killed mid-dump can leave a partial file behind.
find "$backup_root" -maxdepth 1 -type f -name '.nyabase-*.partial.*' -mtime +1 -delete

echo "nyabase-backup: $archive"
