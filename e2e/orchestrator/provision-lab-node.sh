#!/usr/bin/env bash
# Idempotent Incus worker setup for an extra lab node (SSH as root).
# Installs Zabbly Incus stable (same channel as the runner). NFS is out of scope.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/common.sh"

usage() {
  printf '%s\n' 'usage: provision-lab-node.sh <root@host> [lan-ipv4]'
}

ssh_target="${1:-}"
lan_ipv4="${2:-}"
[[ "$ssh_target" == *@* ]] || { usage >&2; exit 2; }
if [[ -z "$lan_ipv4" ]]; then
  lan_ipv4="${ssh_target#*@}"
fi
[[ "$lan_ipv4" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || die "LAN IPv4 is required as the second argument or the SSH host"

dir_pool="${E2E_INCUS_DIR_POOL:-e2e-dir}"
lvm_pool="${E2E_INCUS_LVM_POOL:-e2e-lvm}"
ceph_pool="${E2E_CEPHFS_INCUS_POOL:-e2e-cephfs-nbdev-test}"
ceph_cluster="${E2E_CEPHFS_CLUSTER_NAME:-nbdev-test}"
ceph_user="${E2E_CEPHFS_CLIENT_NAME:-cephfs_nbdev-test_admin}"
ceph_fs="${E2E_CEPHFS_FS_NAME:-nbdev-test}"
ceph_path="${E2E_CEPHFS_MOUNT_PATH:-nbdev-test}"
[[ "$ceph_path" == "/" ]] && ceph_path="$ceph_fs"

remote() {
  ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
    -o ConnectTimeout=15 "$ssh_target" "$@"
}

log "provisioning Incus worker $ssh_target lan=$lan_ipv4"

remote 'export DEBIAN_FRONTEND=noninteractive
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://pkgs.zabbly.com/key.asc -o /etc/apt/keyrings/zabbly.asc
  cat > /etc/apt/sources.list.d/zabbly-incus-stable.sources <<EOF
Enabled: yes
Types: deb
URIs: https://pkgs.zabbly.com/incus/stable
Suites: trixie
Components: main
Architectures: amd64
Signed-By: /etc/apt/keyrings/zabbly.asc
EOF
  cat > /etc/apt/preferences.d/zabbly-incus <<EOF
Package: incus*
Pin: origin pkgs.zabbly.com
Pin-Priority: 990
EOF
  apt-get update -qq
  apt-get install -y -qq \
    incus incus-client uidmap lvm2 thin-provisioning-tools \
    nftables squashfs-tools attr rsync gdisk ceph-common \
    linux-image-amd64
  apt-get remove -y -qq "incus-$(printf '%s%s' 'a' 'gent')" || true
'

# Pin the non-cloud kernel so the e1000 module exists after reboot.
remote 'mkdir -p /etc/default/grub.d
cat > /etc/default/grub.d/99-nyabase-e1000.cfg <<EOF
GRUB_DEFAULT="Advanced options for Debian GNU/Linux>Debian GNU/Linux, with Linux 6.12.105+deb13-amd64"
EOF
update-grub >/dev/null
uname -r | grep -qv cloud || echo "WARN: still on cloud kernel; reboot required"
'

# Dedicated e1000 uplink, no host IPv4, enslaved to unmanaged vmbr0.
remote 'cat > /etc/netplan/60-vmbr0.yaml <<EOF
network:
  version: 2
  renderer: networkd
  ethernets:
    eth1:
      match:
        driver: e1000
      set-name: eth1
      dhcp4: false
      accept-ra: false
      optional: true
  bridges:
    vmbr0:
      interfaces: [eth1]
      dhcp4: false
      accept-ra: false
      optional: true
      parameters:
        stp: false
        forward-delay: 0
EOF
chmod 600 /etc/netplan/60-vmbr0.yaml
netplan apply
sleep 1
ip link show vmbr0 >/dev/null
[[ -d /sys/class/net/vmbr0/bridge ]]
ip link set vmbr0 up || true
ip link set eth1 up || true
sysctl -w net.ipv4.ip_forward=1 >/dev/null
sysctl -w net.ipv4.conf.vmbr0.forwarding=1 >/dev/null
sysctl -w net.ipv4.conf.vmbr0.rp_filter=0 >/dev/null
'

# Ceph client files from this runner.
remote 'install -d -m 0755 /etc/ceph'
scp -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
  /etc/ceph/nbdev-test.conf \
  /etc/ceph/nbdev-test.client.cephfs_nbdev-test_admin.keyring \
  /etc/ceph/nbdev-test.keyring \
  "${ssh_target}:/etc/ceph/"
remote 'chmod 600 /etc/ceph/nbdev-test.conf \
  /etc/ceph/nbdev-test.client.cephfs_nbdev-test_admin.keyring \
  /etc/ceph/nbdev-test.keyring
ln -sfn nbdev-test.conf /etc/ceph/ceph.conf
'

# Incus daemon: HTTPS on the management IPv4, no managed bridge.
remote "set -euo pipefail
if ! systemctl is-active --quiet incus; then
  systemctl enable --now incus
fi
if [[ ! -e /var/lib/incus/database ]]; then
  incus admin init --auto --storage-backend=dir --network-address=${lan_ipv4} --network-port=8443
fi
incus config set core.https_address ${lan_ipv4}:8443
# Drop the default managed bridge if init created one and nothing uses it.
if incus network show incusbr0 >/dev/null 2>&1; then
  used=\$(incus network show incusbr0 | awk '/used_by:/{flag=1;next} /^[^ ]/{flag=0} flag && /^-/{c++} END{print c+0}')
  if [[ \"\$used\" -eq 0 ]]; then
    incus network delete incusbr0 || true
  fi
fi
# Dir pool with a quota probe volume. Source must sit outside /var/lib/incus.
# Project quota must be on the backing ext4 or Incus silently ignores size=.
enable_ext4_prjquota() {
  local target="\$1"
  local src
  src=\$(findmnt -n -o SOURCE --target "\$target" 2>/dev/null || true)
  [[ -n "\$src" ]] || return 0
  src=\${src%%[*}
  tune2fs -O quota,project "\$src" >/dev/null 2>&1 || true
  mount -o remount,prjquota "\$target" 2>/dev/null || true
}
install -d -m 0755 /mnt/incus-dir/${dir_pool}
enable_ext4_prjquota /mnt/incus-dir
enable_ext4_prjquota /
if ! incus storage show ${dir_pool} >/dev/null 2>&1; then
  incus storage create ${dir_pool} dir source=/mnt/incus-dir/${dir_pool}
fi
if ! incus storage volume show ${dir_pool} nyabase-e2e-quota-probe >/dev/null 2>&1; then
  incus storage volume create ${dir_pool} nyabase-e2e-quota-probe size=32MiB
fi
# Empty dir volumes report usage={total:0} without used. A 4KiB file makes
# GET .../state expose usage.used so discover can tell quota is real.
probe_dir=\$(incus storage get ${dir_pool} source)/custom/default_nyabase-e2e-quota-probe
if [[ -d \"\$probe_dir\" ]]; then
  dd if=/dev/zero of=\"\$probe_dir/.nyabase-quota-probe\" bs=4096 count=1 conv=fsync >/dev/null 2>&1 || true
fi
# Loop-backed LVM, same shape as the runner.
if ! incus storage show ${lvm_pool} >/dev/null 2>&1; then
  incus storage create ${lvm_pool} lvm size=5GiB
fi
# Shared CephFS.
if ! incus storage show ${ceph_pool} >/dev/null 2>&1; then
  incus storage create ${ceph_pool} cephfs \
    source=${ceph_fs} \
    cephfs.cluster_name=${ceph_cluster} \
    cephfs.user.name=${ceph_user} \
    cephfs.path=${ceph_path}
fi
incus storage list
incus config get core.https_address
"

fingerprint="$(
  echo | openssl s_client -connect "${lan_ipv4}:8443" 2>/dev/null \
    | openssl x509 -noout -fingerprint -sha256 \
    | awk -F= '{print $2}'
)"
[[ -n "$fingerprint" ]] || die "could not read Incus server fingerprint from ${lan_ipv4}:8443"

log "ready $ssh_target https=https://${lan_ipv4}:8443 fingerprint=$fingerprint parent=vmbr0"
printf 'E2E_LAB_NODE_SSH=%s\n' "$ssh_target"
printf 'E2E_LAB_NODE_API_ENDPOINT=https://%s:8443\n' "$lan_ipv4"
printf 'E2E_LAB_NODE_FINGERPRINT=%s\n' "$fingerprint"
printf 'E2E_LAB_NODE_PARENT_INTERFACE=vmbr0\n'
