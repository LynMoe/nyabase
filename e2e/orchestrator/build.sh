#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
run_id="$(require_run_id "${1:-}")"
initialize_run "$run_id"

completed=false
cleanup_failed_build() {
  local rc=$?
  if [[ "$completed" != true ]]; then
    "$E2E_ROOT/e2e/orchestrator/down.sh" "$run_id" --keep-runtime >/dev/null 2>&1 || true
  fi
  exit "$rc"
}
trap cleanup_failed_build EXIT
trap 'exit 130' INT TERM HUP

docker_build() {
  local description="$1"
  shift
  local attempt
  for attempt in 1 2 3; do
    if docker build "$@"; then
      return 0
    fi
    if ((attempt == 3)); then
      die "$description failed after $attempt bounded attempts"
    fi
    log "$description attempt $attempt failed; retrying after transient-registry backoff"
    sleep "$((attempt * 2))"
  done
}

manifest_phase building
log "building current-worktree production Backend image"
docker_build 'Backend image build' \
  --label "io.nyabase.e2e.run-id=$run_id" \
  --label 'io.nyabase.e2e.component=backend' \
  -f "$E2E_ROOT/deploy/Dockerfile.backend" \
  -t "$NYABASE_E2E_BACKEND_IMAGE" "$E2E_ROOT"
manifest_resource image "$NYABASE_E2E_BACKEND_IMAGE"

log "building immutable current-worktree CPU node image"
docker_build 'CPU node image build' \
  --build-arg "E2E_RUN_ID=$run_id" \
  -f "$E2E_ROOT/e2e/topology/docker-dind/node.Dockerfile" \
  -t "$NYABASE_E2E_NODE_IMAGE" "$E2E_ROOT"
manifest_resource image "$NYABASE_E2E_NODE_IMAGE"

ssh_proxy_id=""
http_proxy_id=""
proxy_target_id=""
nfs_fixture_id=""
ceph_fixture_id=""
storage_client_id=""
if [[ "$NYABASE_E2E_PROFILE" == full ]]; then
  log "building current-worktree production SSH proxy image"
  docker_build 'SSH proxy image build' \
    --target ssh-proxy \
    --label "io.nyabase.e2e.run-id=$run_id" \
    --label 'io.nyabase.e2e.component=ssh-proxy' \
    -f "$E2E_ROOT/e2e/topology/docker-dind/proxies.Dockerfile" \
    -t "$NYABASE_E2E_SSH_PROXY_IMAGE" "$E2E_ROOT"
  manifest_resource image "$NYABASE_E2E_SSH_PROXY_IMAGE"

  log "building current-worktree production HTTP proxy image"
  docker_build 'HTTP proxy image build' \
    --target http-proxy \
    --label "io.nyabase.e2e.run-id=$run_id" \
    --label 'io.nyabase.e2e.component=http-proxy' \
    -f "$E2E_ROOT/e2e/topology/docker-dind/proxies.Dockerfile" \
    -t "$NYABASE_E2E_HTTP_PROXY_IMAGE" "$E2E_ROOT"
  manifest_resource image "$NYABASE_E2E_HTTP_PROXY_IMAGE"

  log "building current-worktree CPU proxy target image"
  docker_build 'proxy target image build' \
    --label "io.nyabase.e2e.run-id=$run_id" \
    --label 'io.nyabase.e2e.component=proxy-target' \
    -f "$E2E_ROOT/e2e/images/proxy-target/Dockerfile" \
    -t "$NYABASE_E2E_PROXY_TARGET_IMAGE" "$E2E_ROOT"
  manifest_resource image "$NYABASE_E2E_PROXY_TARGET_IMAGE"

  log "building CPU userspace NFS-Ganesha fixture image"
  docker_build 'NFS fixture image build' \
    --label "io.nyabase.e2e.run-id=$run_id" \
    --label 'io.nyabase.e2e.component=nfs-fixture' \
    -f "$E2E_ROOT/e2e/images/storage/nfs/Dockerfile" \
    -t "$NYABASE_E2E_NFS_IMAGE" "$E2E_ROOT/e2e/images/storage/nfs"
  manifest_resource image "$NYABASE_E2E_NFS_IMAGE"

  log "building pinned CPU CephFS fixture image"
  docker_build 'CephFS fixture image build' \
    --label "io.nyabase.e2e.run-id=$run_id" \
    --label 'io.nyabase.e2e.component=cephfs-fixture' \
    -f "$E2E_ROOT/e2e/images/storage/ceph/Dockerfile" \
    -t "$NYABASE_E2E_CEPH_IMAGE" "$E2E_ROOT/e2e/images/storage/ceph"
  manifest_resource image "$NYABASE_E2E_CEPH_IMAGE"

  log "building CPU kernel storage probe image"
  docker_build 'storage client image build' \
    --label "io.nyabase.e2e.run-id=$run_id" \
    --label 'io.nyabase.e2e.component=storage-client' \
    -f "$E2E_ROOT/e2e/images/storage/client/Dockerfile" \
    -t "$NYABASE_E2E_STORAGE_CLIENT_IMAGE" "$E2E_ROOT/e2e/images/storage/client"
  manifest_resource image "$NYABASE_E2E_STORAGE_CLIENT_IMAGE"

  ssh_proxy_id="$(docker image inspect "$NYABASE_E2E_SSH_PROXY_IMAGE" --format '{{.Id}}')"
  http_proxy_id="$(docker image inspect "$NYABASE_E2E_HTTP_PROXY_IMAGE" --format '{{.Id}}')"
  proxy_target_id="$(docker image inspect "$NYABASE_E2E_PROXY_TARGET_IMAGE" --format '{{.Id}}')"
  nfs_fixture_id="$(docker image inspect "$NYABASE_E2E_NFS_IMAGE" --format '{{.Id}}')"
  ceph_fixture_id="$(docker image inspect "$NYABASE_E2E_CEPH_IMAGE" --format '{{.Id}}')"
  storage_client_id="$(docker image inspect "$NYABASE_E2E_STORAGE_CLIENT_IMAGE" --format '{{.Id}}')"
fi

backend_id="$(docker image inspect "$NYABASE_E2E_BACKEND_IMAGE" --format '{{.Id}}')"
node_id="$(docker image inspect "$NYABASE_E2E_NODE_IMAGE" --format '{{.Id}}')"
product_source_digest="$(
  {
    find "$E2E_ROOT/packages" "$E2E_ROOT/deploy" "$E2E_ROOT/e2e" \
      "$E2E_ROOT/tools" "$E2E_ROOT/scripts" "$E2E_ROOT/package.json" \
      "$E2E_ROOT/pnpm-lock.yaml" "$E2E_ROOT/pnpm-workspace.yaml" \
      "$E2E_ROOT/tsconfig.base.json" "$E2E_ROOT/.dockerignore" \
      "$E2E_ROOT/.gitignore" \
      \( -type d \( -name node_modules -o -name dist -o -name dist-esm \
        -o -name target -o -path "$E2E_ROOT/e2e/.runtime" \) -prune \) \
      -o -type f -print0 \
      | sort -z | xargs -0 -r sha256sum
    if [[ -e "$E2E_ROOT/test" ]]; then
      find "$E2E_ROOT/test" -type f -print0 | sort -z | xargs -0 -r sha256sum
    else
      printf '%s\n' 'ROOT_TEST_PATH=ABSENT'
    fi
  } | sha256sum | awk '{print $1}'
)"
mapfile -t provenance_pathspec < <(
  sed '/^[[:space:]]*$/d' "$E2E_ROOT/e2e/orchestrator/release-source-pathspec.txt"
)
# The single pathspec file is consumed byte-for-byte by coverage/validate.mjs.
# It binds production/runtime inputs, test/evidence implementation, the retired
# root test tree's tracked deletion/absence, and ignore-rule bytes.
tracked_diff_digest="$(git -C "$E2E_ROOT" diff --binary HEAD -- \
  "${provenance_pathspec[@]}" \
  | sha256sum | awk '{print $1}')"
untracked_source_digest="$(
  git -C "$E2E_ROOT" ls-files -z --others --exclude-standard -- \
    "${provenance_pathspec[@]}" \
    | sort -z \
    | while IFS= read -r -d '' file; do sha256sum "$E2E_ROOT/$file"; done \
    | sha256sum | awk '{print $1}'
)"
if [[ -n "$(git -C "$E2E_ROOT" status --porcelain=v1 --untracked-files=normal -- \
  "${provenance_pathspec[@]}")" ]]; then
  git_dirty=true
else
  git_dirty=false
fi

image_tree_digest() {
  local image="$1" path="$2"
  docker run --rm --entrypoint sh "$image" -ec \
    'find "$1" -type f -exec sha256sum {} + | sort | sha256sum | cut -d " " -f 1' \
    sh "$path"
}

backend_dist_digest="$(image_tree_digest "$NYABASE_E2E_BACKEND_IMAGE" /app/dist)"
frontend_dist_digest="$(image_tree_digest "$NYABASE_E2E_BACKEND_IMAGE" /app/public)"
backend_common_digest="$(image_tree_digest "$NYABASE_E2E_BACKEND_IMAGE" /app/node_modules/@nyabase/common/dist)"
agent_dist_digest="$(image_tree_digest "$NYABASE_E2E_NODE_IMAGE" /opt/nyabase-agent/dist)"
agent_common_digest="$(image_tree_digest "$NYABASE_E2E_NODE_IMAGE" /opt/nyabase-agent/node_modules/@nyabase/common/dist)"
install -m 0600 /dev/null "$NYABASE_E2E_RUNTIME_DIR/build.env"
{
  printf '%s\n' \
    'BUILD_SCHEMA_VERSION=1' \
    "E2E_PROFILE=$NYABASE_E2E_PROFILE" \
    "GIT_SHA=$(git -C "$E2E_ROOT" rev-parse HEAD)" \
    "GIT_DIRTY=$git_dirty" \
    "TRACKED_DIFF_SHA256=$tracked_diff_digest" \
    "UNTRACKED_SOURCE_SHA256=$untracked_source_digest" \
    "PRODUCT_SOURCE_SHA256=$product_source_digest" \
    "BACKEND_IMAGE_ID=$backend_id" \
    "NODE_IMAGE_ID=$node_id" \
    "BACKEND_DIST_SHA256=$backend_dist_digest" \
    "FRONTEND_DIST_SHA256=$frontend_dist_digest" \
    "BACKEND_COMMON_DIST_SHA256=$backend_common_digest" \
    "AGENT_DIST_SHA256=$agent_dist_digest" \
    "AGENT_COMMON_DIST_SHA256=$agent_common_digest"
  if [[ "$NYABASE_E2E_PROFILE" == full ]]; then
    printf '%s\n' \
      "SSH_PROXY_IMAGE_ID=$ssh_proxy_id" \
      "HTTP_PROXY_IMAGE_ID=$http_proxy_id" \
      "PROXY_TARGET_IMAGE_ID=$proxy_target_id" \
      "NFS_FIXTURE_IMAGE_ID=$nfs_fixture_id" \
      "CEPH_FIXTURE_IMAGE_ID=$ceph_fixture_id" \
      "STORAGE_CLIENT_IMAGE_ID=$storage_client_id"
  fi
  printf '%s\n' "BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$NYABASE_E2E_RUNTIME_DIR/build.env"

manifest_phase built
completed=true
trap - EXIT INT TERM HUP
log "build PASS: profile=$NYABASE_E2E_PROFILE backend=$backend_id node=$node_id"
