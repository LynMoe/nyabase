#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
run_id="$(require_run_id "${1:-}")"
load_run "$run_id"

[[ "$NYABASE_E2E_PROFILE" == full ]] || die 'storage fixtures are owned only by the Full profile'
[[ -s "$NYABASE_E2E_RUNTIME_DIR/build.env" ]] || die 'Full build evidence is missing'
docker network inspect "$NYABASE_E2E_NETWORK" >/dev/null 2>&1 \
  || die 'the current-run cluster network is not ready'
for image in "$NYABASE_E2E_NFS_IMAGE" "$NYABASE_E2E_CEPH_IMAGE" \
  "$NYABASE_E2E_STORAGE_CLIENT_IMAGE"; do
  docker image inspect "$image" >/dev/null 2>&1 || die "Full storage image is missing: $image"
done

storage_dir="$NYABASE_E2E_RUNTIME_DIR/storage"
secret_dir="$storage_dir/secrets"
ceph_data_dir="$storage_dir/ceph-data"
ceph_etc_dir="$storage_dir/ceph-etc"
nfs_export_dir="$storage_dir/nfs-export"
backing_file="$storage_dir/ceph-osd.raw"
loop_file="$storage_dir/ceph-loop-device"
nfs_name="$NYABASE_E2E_PREFIX-nfs-fixture"
ceph_name="$NYABASE_E2E_PREFIX-cephfs-fixture"
client_name="$NYABASE_E2E_PREFIX-storage-readiness"

[[ ! -e "$storage_dir" ]] || die 'Full storage runtime already exists for this run'
install -d -m 0700 "$storage_dir" "$secret_dir" "$ceph_data_dir" \
  "$ceph_etc_dir" "$nfs_export_dir"
snapshot_host_nfsd "$storage_dir/nfsd.before"

truncate --size 6G "$backing_file"
chmod 0600 "$backing_file"
loop_device="$(losetup --find --show "$backing_file")"
[[ "$loop_device" =~ ^/dev/loop[0-9]+$ && -b "$loop_device" ]] \
  || die 'could not allocate the exact Full CephFS loop device'
install -m 0600 /dev/null "$loop_file"
printf '%s\n' "$loop_device" > "$loop_file"
manifest_resource loop-device "$loop_device@$backing_file"

ceph_fsid="$(cat /proc/sys/kernel/random/uuid)"
docker run -d \
  --name "$nfs_name" --hostname nfs-ganesha \
  --label "io.nyabase.e2e.run-id=$run_id" \
  --label 'io.nyabase.e2e.managed=true' \
  --label 'io.nyabase.e2e.component=nfs-fixture' \
  --network "$NYABASE_E2E_NETWORK" --ip "$NYABASE_E2E_NFS_IP" \
  --privileged --cpus 0.75 --memory 768m --stop-timeout 10 \
  --env "NFS_CLIENT_CIDR=$NYABASE_E2E_SUBNET" \
  --mount "type=bind,src=$nfs_export_dir,dst=/srv/export" \
  "$NYABASE_E2E_NFS_IMAGE" >/dev/null
manifest_resource container "$nfs_name"

docker run -d \
  --name "$ceph_name" --hostname ceph \
  --label "io.nyabase.e2e.run-id=$run_id" \
  --label 'io.nyabase.e2e.managed=true' \
  --label 'io.nyabase.e2e.component=cephfs-fixture' \
  --network "$NYABASE_E2E_NETWORK" --ip "$NYABASE_E2E_CEPH_IP" \
  --privileged --cpus 2 --memory 4g --memory-swap 4g \
  --ulimit nofile=1048576:1048576 --stop-timeout 30 \
  --env "CEPH_FSID=$ceph_fsid" \
  --env "CEPH_IP=$NYABASE_E2E_CEPH_IP" \
  --env "CEPH_NETWORK=$NYABASE_E2E_SUBNET" \
  --env "CEPH_OSD_DEVICE=$loop_device" \
  --mount "type=bind,src=$ceph_data_dir,dst=/var/lib/ceph" \
  --mount "type=bind,src=$ceph_etc_dir,dst=/etc/ceph" \
  --mount "type=bind,src=$secret_dir,dst=/run/nyabase-secrets" \
  "$NYABASE_E2E_CEPH_IMAGE" >/dev/null
manifest_resource container "$ceph_name"

for _ in $(seq 1 300); do
  [[ -f "$secret_dir/ready" ]] && break
  [[ "$(docker inspect --format '{{.State.Running}}' "$ceph_name" 2>/dev/null || true)" == true ]] \
    || die 'CephFS fixture exited before readiness'
  sleep 1
done
[[ -f "$secret_dir/ready" ]] || die 'CephFS fixture readiness timed out'
[[ "$(docker inspect --format '{{.State.Running}}' "$nfs_name")" == true ]] \
  || die 'NFS fixture exited before readiness'

client_secret="$secret_dir/ceph.client.nyabase.secret"
[[ -s "$client_secret" ]] || die 'CephFS fixture did not create its client credential'
[[ "$(stat -c '%a' "$client_secret")" == 600 ]] || die 'CephFS client credential is not mode 0600'
while IFS= read -r keyring; do
  [[ "$(stat -c '%a' "$keyring")" == 600 ]] || die 'a CephFS keyring is not mode 0600'
done < <(find "$ceph_data_dir" "$ceph_etc_dir" -type f -name '*keyring*' -print)
ceph_secret="$(tr -d '\n' < "$client_secret")"
[[ "$ceph_secret" =~ ^[A-Za-z0-9+/]+={0,2}$ ]] || die 'CephFS client credential has an invalid envelope'
! grep -q '^CEPH_CLIENT_SECRET=' "$NYABASE_E2E_RUNTIME_DIR/secrets.env" \
  || die 'CephFS client credential was already registered'
printf 'CEPH_CLIENT_SECRET=%s\n' "$ceph_secret" >> "$NYABASE_E2E_RUNTIME_DIR/secrets.env"
unset ceph_secret

install -m 0600 /dev/null "$storage_dir/nfs-fixture.json"
install -m 0600 /dev/null "$storage_dir/cephfs-fixture.json"
node --input-type=module - \
  "$storage_dir/nfs-fixture.json" "$run_id" "$NYABASE_E2E_NFS_IP" <<'NODE'
import { writeFileSync } from 'node:fs';
const [path, runId, host] = process.argv.slice(2);
writeFileSync(path, `${JSON.stringify({
  schemaVersion: 1,
  runId,
  type: 'nfs',
  options: 'hard,proto=tcp,timeo=50,retrans=2',
  params: { type: 'nfs', nfsServer: host, exportPath: '/nyabase', version: '4.2' },
}, null, 2)}\n`, { mode: 0o600 });
NODE
node --input-type=module - \
  "$storage_dir/cephfs-fixture.json" "$run_id" "$NYABASE_E2E_CEPH_IP" "$client_secret" <<'NODE'
import { writeFileSync } from 'node:fs';
const [path, runId, host, secretFile] = process.argv.slice(2);
writeFileSync(path, `${JSON.stringify({
  schemaVersion: 1,
  runId,
  type: 'cephfs',
  options: '',
  secretFile,
  params: {
    type: 'cephfs', monHosts: `${host}:6789`, fsName: 'nyabasefs',
    exportPath: '/', clientName: 'nyabase',
  },
}, null, 2)}\n`, { mode: 0o600 });
NODE

docker run -d \
  --name "$client_name" --hostname "$client_name" \
  --label "io.nyabase.e2e.run-id=$run_id" \
  --label 'io.nyabase.e2e.managed=true' \
  --label 'io.nyabase.e2e.component=storage-readiness' \
  --network "$NYABASE_E2E_NETWORK" --ip "$NYABASE_E2E_STORAGE_CLIENT_IP" \
  --privileged --cpus 0.75 --memory 768m --stop-timeout 5 \
  --tmpfs /mnt:rw,nosuid,nodev,size=64m \
  --mount type=bind,src=/lib/modules,dst=/lib/modules,readonly \
  --mount "type=bind,src=$client_secret,dst=/run/secrets/ceph.client.nyabase.secret,readonly" \
  "$NYABASE_E2E_STORAGE_CLIENT_IMAGE" >/dev/null
manifest_resource container "$client_name"
docker exec "$client_name" mkdir -p /mnt/nfs /mnt/ceph
timeout 30 docker exec "$client_name" modprobe ceph >/dev/null
timeout 30 docker exec "$client_name" modprobe nfs >/dev/null

nfs_ready=false
for _ in $(seq 1 60); do
  if docker exec "$client_name" bash -c \
    "exec 3<>/dev/tcp/$NYABASE_E2E_NFS_IP/2049" >/dev/null 2>&1; then
    nfs_ready=true
    break
  fi
  sleep 1
done
[[ "$nfs_ready" == true ]] || die 'NFS fixture did not accept TCP/2049 connections'
timeout 60 docker exec "$client_name" mount -t nfs \
  -o vers=4.2,proto=tcp,hard,timeo=50,retrans=2,nosharecache,noac,lookupcache=none \
  "$NYABASE_E2E_NFS_IP:/nyabase" /mnt/nfs
timeout 90 docker exec "$client_name" mount -t ceph \
  "$NYABASE_E2E_CEPH_IP:6789:/" /mnt/ceph \
  -o name=nyabase,fs=nyabasefs,secretfile=/run/secrets/ceph.client.nyabase.secret

nfs_marker="$run_id:nfs:readiness"
ceph_marker="$run_id:cephfs:readiness"
docker exec -e "MARKER=$nfs_marker" "$client_name" sh -eu -c \
  'printf "%s\n" "$MARKER" > /mnt/nfs/.nyabase-readiness; sync /mnt/nfs/.nyabase-readiness'
docker exec -e "MARKER=$ceph_marker" "$client_name" sh -eu -c \
  'printf "%s\n" "$MARKER" > /mnt/ceph/.nyabase-readiness; sync /mnt/ceph/.nyabase-readiness'
[[ "$(docker exec "$nfs_name" sh -c 'tr -d "\n" < /srv/export/.nyabase-readiness')" == "$nfs_marker" ]] \
  || die 'NFS fixture readiness marker did not reach the server export'
[[ "$(docker exec "$client_name" findmnt -n -o FSTYPE --mountpoint /mnt/nfs)" == nfs4 ]] \
  || die 'NFS readiness did not use a kernel nfs4 mount'
[[ "$(docker exec "$client_name" findmnt -n -o FSTYPE --mountpoint /mnt/ceph)" == ceph ]] \
  || die 'CephFS readiness did not use a kernel ceph mount'

timeout 60 docker exec "$client_name" umount /mnt/ceph
timeout 60 docker exec "$client_name" umount /mnt/nfs
! docker exec "$client_name" mountpoint -q /mnt/ceph || die 'CephFS readiness mount remained'
! docker exec "$client_name" mountpoint -q /mnt/nfs || die 'NFS readiness mount remained'
docker rm -f "$client_name" >/dev/null
manifest_retire_resource container "$client_name"

node --input-type=module - \
  "$NYABASE_E2E_RUNTIME_DIR/storage-readiness.json" "$run_id" "$ceph_fsid" \
  "$(sha256sum "$storage_dir/nfsd.before" | awk '{print $1}')" \
  "$HOST_NFSD_SNAPSHOT_CONTRACT" <<'NODE'
import { writeFileSync } from 'node:fs';
const [path, runId, cephFsid, hostNfsdBeforeSha256, hostNfsdSnapshotContract] = process.argv.slice(2);
writeFileSync(path, `${JSON.stringify({
  schemaVersion: 1,
  runId,
  nfs: { implementation: 'Ganesha 6.5', protocol: 'NFSv4.2', kernelMount: true },
  cephfs: { release: '19.2.3', fsid: cephFsid, kernelMount: true, osdUpIn: 1, mdsActive: 1 },
  exactUnmounts: 2,
  credentialMode: '600',
  hostNfsdSnapshotContract,
  hostNfsdBeforeSha256,
  observedAt: new Date().toISOString(),
}, null, 2)}\n`, { mode: 0o600 });
NODE

log 'Full storage fixtures PASS: real NFSv4.2 and CephFS kernel mounts are ready'
