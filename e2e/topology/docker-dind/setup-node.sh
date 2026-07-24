#!/usr/bin/env bash
set -euo pipefail

node_id="${NYABASE_E2E_NODE_ID:?NYABASE_E2E_NODE_ID is required}"
run_id="${NYABASE_E2E_RUN_ID:?NYABASE_E2E_RUN_ID is required}"
image_size="${NYABASE_E2E_XFS_SIZE:-4G}"

case "$node_id" in
  node1|node2) ;;
  *) echo "unsupported node id: $node_id" >&2; exit 2 ;;
esac
[[ "$run_id" =~ ^[a-z0-9][a-z0-9-]{2,47}$ ]] || {
  echo "invalid run id" >&2
  exit 2
}

runtime=/var/lib/nyabase-e2e
image_path="$runtime/${run_id}-${node_id}.xfs"
xfs_mount=/mnt/nyabase-xfs
docker_root=/var/lib/nyabase-docker
data_root=/data/nyabase
input_config=/run/nyabase-e2e/agent.yaml
input_ca=/run/nyabase-e2e/ca.crt

test -s "$input_config"
test -s "$input_ca"
test ! -e "$runtime/ready"

install -d -m 0700 "$runtime"
install -d -m 0755 "$xfs_mount" "$docker_root" "$data_root" /etc/nyabase
install -m 0600 "$input_config" /etc/nyabase/agent.yaml
install -m 0644 "$input_ca" /usr/local/share/ca-certificates/nyabase-e2e.crt
update-ca-certificates >/dev/null
install -d -m 0755 /etc/docker/certs.d/registry:5000
install -m 0644 "$input_ca" /etc/docker/certs.d/registry:5000/ca.crt

machine_id="$(tr -d '\n' </etc/machine-id)"
[[ "$machine_id" =~ ^[0-9a-f]{32}$ ]] || {
  echo "systemd did not provision a unique machine id" >&2
  exit 1
}
printf '%s\n' "$machine_id" > "$runtime/machine-id"

if [[ ! -c /dev/loop-control ]]; then
  mknod -m 0660 /dev/loop-control c 10 237
fi
for minor in $(seq 0 31); do
  [[ -b "/dev/loop${minor}" ]] || mknod -m 0660 "/dev/loop${minor}" b 7 "$minor"
done

loopdev=""
rollback() {
  set +e
  mountpoint -q "$data_root" && umount "$data_root"
  mountpoint -q "$docker_root" && umount "$docker_root"
  mountpoint -q "$xfs_mount" && umount "$xfs_mount"
  [[ -n "$loopdev" ]] && losetup -d "$loopdev" 2>/dev/null || true
}
trap rollback ERR INT TERM

truncate -s "$image_size" "$image_path"
# Debian's util-linux losetup does not expose an --autoclear flag. The node
# teardown detaches this exact recorded device, while this trap covers setup
# failures after allocation.
loopdev="$(losetup --find --show "$image_path")"
printf '%s\n' "$loopdev" > "$runtime/loop-device"

mkfs.xfs -f -n ftype=1 "$loopdev" >/dev/null
mount -o prjquota "$loopdev" "$xfs_mount"
install -d -m 0755 "$xfs_mount/docker" "$xfs_mount/data"
mount --bind "$xfs_mount/docker" "$docker_root"
mount --bind "$xfs_mount/data" "$data_root"

findmnt -n -o FSTYPE --mountpoint "$docker_root" | grep -qx xfs
findmnt -n -o FSTYPE --mountpoint "$data_root" | grep -qx xfs
findmnt -n -o OPTIONS --mountpoint "$xfs_mount" | grep -Eq '(^|,)(pquota|prjquota)(,|$)'
xfs_quota -x -c state "$data_root" | grep -Eq 'Project quota state.*on|Accounting: ON'

install -m 0644 /dev/null /etc/systemd/system/nyabase-agent.service
printf '%s\n' \
  '[Unit]' \
  'Description=nyabase Agent (real CPU E2E)' \
  'After=network-online.target' \
  'Wants=network-online.target' \
  '' \
  '[Service]' \
  'Type=simple' \
  'User=root' \
  'WorkingDirectory=/opt/nyabase-agent' \
  'Environment=NODE_ENV=production' \
  'Environment=NODE_EXTRA_CA_CERTS=/etc/ssl/certs/nyabase-e2e.pem' \
  'ExecStart=/usr/local/bin/node /opt/nyabase-agent/dist/main.js' \
  'Restart=on-failure' \
  'RestartSec=2' \
  'KillMode=control-group' \
  'TimeoutStopSec=30s' \
  'SendSIGKILL=yes' \
  'RuntimeDirectory=nyabase-agent' \
  'StateDirectory=nyabase-agent' \
  'StateDirectoryMode=0700' \
  '' \
  '[Install]' \
  'WantedBy=multi-user.target' > /etc/systemd/system/nyabase-agent.service

systemctl daemon-reload
systemctl enable --now nyabase-agent.service
touch "$runtime/ready"
trap - ERR INT TERM
