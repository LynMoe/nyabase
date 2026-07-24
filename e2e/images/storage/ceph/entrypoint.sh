#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

: "${CEPH_FSID:?CEPH_FSID is required}"
: "${CEPH_IP:?CEPH_IP is required}"
: "${CEPH_NETWORK:?CEPH_NETWORK is required}"
: "${CEPH_OSD_DEVICE:?CEPH_OSD_DEVICE is required}"
: "${CEPH_SECRET_DIR:=/run/nyabase-secrets}"

if [[ ! "$CEPH_FSID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
  echo "invalid CEPH_FSID" >&2
  exit 2
fi
if [[ ! "$CEPH_IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
  echo "invalid CEPH_IP" >&2
  exit 2
fi
if [[ ! "$CEPH_NETWORK" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}/24$ ]]; then
  echo "invalid CEPH_NETWORK" >&2
  exit 2
fi
if [[ ! "$CEPH_OSD_DEVICE" =~ ^/dev/loop[0-9]+$ ]] || [[ ! -b "$CEPH_OSD_DEVICE" ]]; then
  echo "CEPH_OSD_DEVICE must be an existing loop block device" >&2
  exit 2
fi
if [[ ! -d "$CEPH_SECRET_DIR" ]] || [[ ! -w "$CEPH_SECRET_DIR" ]]; then
  echo "CEPH_SECRET_DIR must be a writable directory" >&2
  exit 2
fi

declare -a daemon_pids=()
declare -a daemon_names=()
shutdown_requested=0

log() {
  printf '[ceph-fixture] %s\n' "$*"
}

on_signal() {
  shutdown_requested=1
}

stop_daemons() {
  local index
  set +e
  for ((index=${#daemon_pids[@]} - 1; index >= 0; index--)); do
    if kill -0 "${daemon_pids[$index]}" 2>/dev/null; then
      kill -TERM "${daemon_pids[$index]}" 2>/dev/null
    fi
  done
  for ((index=${#daemon_pids[@]} - 1; index >= 0; index--)); do
    wait "${daemon_pids[$index]}" 2>/dev/null
  done
}

start_daemon() {
  local name=$1
  shift
  "$@" >>"/var/log/ceph/${name}.log" 2>&1 &
  daemon_names+=("$name")
  daemon_pids+=("$!")
}

wait_for_cli() {
  local attempt
  for attempt in $(seq 1 90); do
    if (( ${#daemon_pids[@]} > 0 )) && ! kill -0 "${daemon_pids[0]}" 2>/dev/null; then
      echo "monitor exited before cluster readiness" >&2
      return 1
    fi
    if ceph --connect-timeout 2 status >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_osd() {
  local attempt
  for attempt in $(seq 1 120); do
    if ceph --connect-timeout 2 osd stat --format json 2>/dev/null |
      python3 -c 'import json,sys; value=json.load(sys.stdin); raise SystemExit(0 if value.get("num_up_osds") == 1 and value.get("num_in_osds") == 1 else 1)' 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_mgr() {
  local attempt
  for attempt in $(seq 1 90); do
    if ceph --connect-timeout 2 status --format json 2>/dev/null |
      python3 -c 'import json,sys; value=json.load(sys.stdin); raise SystemExit(0 if value.get("mgrmap", {}).get("available") is True else 1)' 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_mds() {
  local attempt
  for attempt in $(seq 1 120); do
    if ceph --connect-timeout 2 mds stat 2>/dev/null | grep -q 'up:active'; then
      return 0
    fi
    sleep 1
  done
  return 1
}

trap on_signal TERM INT
trap stop_daemons EXIT

install -d -m 0755 /etc/ceph /run/ceph /var/log/ceph
chown ceph:ceph /etc/ceph /var/lib/ceph
chmod 0750 /etc/ceph /var/lib/ceph
install -d -o ceph -g ceph -m 0750 \
  /var/lib/ceph/mon/ceph-a \
  /var/lib/ceph/mgr/ceph-a \
  /var/lib/ceph/mds/ceph-a \
  /var/lib/ceph/osd \
  /var/lib/ceph/bootstrap-osd
chown ceph:ceph /run/ceph /var/log/ceph

cat >/etc/ceph/ceph.conf <<EOF
[global]
fsid = ${CEPH_FSID}
mon initial members = a
mon host = [v2:${CEPH_IP}:3300/0,v1:${CEPH_IP}:6789/0]
public network = ${CEPH_NETWORK}
cluster network = ${CEPH_NETWORK}
auth cluster required = cephx
auth service required = cephx
auth client required = cephx
ms bind ipv6 = false
osd pool default size = 1
osd pool default min size = 1
osd crush chooseleaf type = 0
mon allow pool size one = true
osd memory target = 536870912
log to file = false
log to stderr = true
err to stderr = true
mon cluster log to stderr = false
EOF
chmod 0600 /etc/ceph/ceph.conf
chown ceph:ceph /etc/ceph/ceph.conf

mon_keyring=/run/ceph/mon.keyring
admin_keyring=/etc/ceph/ceph.client.admin.keyring
monmap=/run/ceph/monmap

ceph-authtool --create-keyring "$mon_keyring" --gen-key -n mon. --cap mon 'allow *' >/dev/null
ceph-authtool --create-keyring "$admin_keyring" --gen-key -n client.admin \
  --cap mon 'allow *' \
  --cap mgr 'allow *' \
  --cap osd 'allow *' \
  --cap mds 'allow *' >/dev/null
ceph-authtool "$mon_keyring" --import-keyring "$admin_keyring" >/dev/null
monmaptool --create --fsid "$CEPH_FSID" \
  --addv a "[v2:${CEPH_IP}:3300/0,v1:${CEPH_IP}:6789/0]" "$monmap" >/dev/null
ceph-mon --mkfs -i a --monmap "$monmap" --keyring "$mon_keyring" \
  >/dev/null 2>/var/log/ceph/mon-mkfs.log
chown -R ceph:ceph /var/lib/ceph/mon/ceph-a
chown -R ceph:ceph /var/log/ceph
chmod 0600 "$admin_keyring"

log 'starting monitor'
start_daemon mon ceph-mon -i a --foreground --setuser ceph --setgroup ceph
if ! wait_for_cli; then
  echo "monitor failed before readiness or did not become reachable within 90 seconds" >&2
  tail -n 40 /var/log/ceph/mon.log >&2 || true
  exit 1
fi

ceph auth get-or-create mgr.a \
  mon 'allow profile mgr' \
  osd 'allow *' \
  mds 'allow *' > /var/lib/ceph/mgr/ceph-a/keyring
chmod 0600 /var/lib/ceph/mgr/ceph-a/keyring
chown -R ceph:ceph /var/lib/ceph/mgr/ceph-a
log 'starting manager'
start_daemon mgr ceph-mgr -i a --foreground --setuser ceph --setgroup ceph
if ! wait_for_mgr; then
  echo "manager did not become available within 90 seconds" >&2
  exit 1
fi

ceph auth get-or-create client.bootstrap-osd \
  mon 'allow profile bootstrap-osd' > /var/lib/ceph/bootstrap-osd/ceph.keyring
chmod 0600 /var/lib/ceph/bootstrap-osd/ceph.keyring
chown -R ceph:ceph /var/lib/ceph/bootstrap-osd

log 'preparing one BlueStore OSD'
ceph-volume raw prepare --bluestore --data "$CEPH_OSD_DEVICE" --osd-id 0 --no-tmpfs \
  > /var/log/ceph/ceph-volume-prepare.log 2>&1
ceph-volume raw activate --device "$CEPH_OSD_DEVICE" --osd-id 0 --no-tmpfs \
  > /var/log/ceph/ceph-volume-activate.log 2>&1
find /var/lib/ceph -type f -name '*keyring*' -exec chmod 0600 {} +
chown -R ceph:ceph /var/lib/ceph/osd/ceph-0
log 'starting OSD'
start_daemon osd ceph-osd -i 0 --foreground --setuser ceph --setgroup ceph
if ! wait_for_osd; then
  echo "OSD did not become up+in within 120 seconds" >&2
  exit 1
fi

ceph osd pool create nyabasefs_metadata 8 >/dev/null
ceph osd pool create nyabasefs_data 8 >/dev/null
ceph osd pool set nyabasefs_metadata size 1 --yes-i-really-mean-it >/dev/null
ceph osd pool set nyabasefs_metadata min_size 1 >/dev/null
ceph osd pool set nyabasefs_data size 1 --yes-i-really-mean-it >/dev/null
ceph osd pool set nyabasefs_data min_size 1 >/dev/null
ceph fs new nyabasefs nyabasefs_metadata nyabasefs_data >/dev/null

ceph auth get-or-create mds.a \
  mon 'allow profile mds' \
  mgr 'allow profile mds' \
  mds 'allow *' \
  osd 'allow rw tag cephfs *=*' > /var/lib/ceph/mds/ceph-a/keyring
chmod 0600 /var/lib/ceph/mds/ceph-a/keyring
chown -R ceph:ceph /var/lib/ceph/mds/ceph-a
log 'starting metadata server'
start_daemon mds ceph-mds -i a --foreground --setuser ceph --setgroup ceph
if ! wait_for_mds; then
  echo "MDS did not become active within 120 seconds" >&2
  exit 1
fi

client_keyring=/run/ceph/client.nyabase.keyring
client_secret="${CEPH_SECRET_DIR}/ceph.client.nyabase.secret"
ceph fs authorize nyabasefs client.nyabase / rw >"$client_keyring"
ceph auth get-key client.nyabase >"$client_secret"
chmod 0600 "$client_keyring" "$client_secret"
touch "${CEPH_SECRET_DIR}/ready"
chmod 0600 "${CEPH_SECRET_DIR}/ready"

health=$(ceph health | awk '{print $1}')
log "cluster ready (mon=1 mgr=1 osd=1 mds=1 health=${health})"

while (( shutdown_requested == 0 )); do
  for index in "${!daemon_pids[@]}"; do
    if ! kill -0 "${daemon_pids[$index]}" 2>/dev/null; then
      wait "${daemon_pids[$index]}" || true
      echo "${daemon_names[$index]} daemon exited unexpectedly" >&2
      exit 1
    fi
  done
  sleep 2
done

log 'shutdown requested'
