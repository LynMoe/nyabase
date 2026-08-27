#!/usr/bin/env bash
# Run reachability plumbing so host-side ssh-proxy can TCP to macvlan guests.
#
# Parent eth0 cannot talk to its own macvlan children. Put a sibling macvlan in
# a dedicated netns together with a veth back to the host:
#   host clients  -> veth-host:2222 -> proxy-in-netns
#   proxy-in-netns -> macvlan -> container:22
#   proxy-in-netns -> veth -> host:3001 (control-plane websocket)
set -euo pipefail

PARENT="${E2E_INCUS_PARENT_INTERFACE:-eth0}"
NS="${E2E_SSH_PROXY_NETNS:-e2e-sshproxy}"
MV_IFACE="${E2E_SSH_PROXY_MACVLAN_IFACE:-mv-sshproxy}"
MV_ADDR="${E2E_SSH_PROXY_MACVLAN_ADDR:-10.8.255.199/16}"
VETH_HOST="${E2E_SSH_PROXY_VETH_HOST:-veth-sp-host}"
VETH_NS="${E2E_SSH_PROXY_VETH_NS:-veth-sp-ns}"
HOST_ADDR="${E2E_SSH_PROXY_VETH_HOST_ADDR:-192.168.231.1/30}"
NS_ADDR="${E2E_SSH_PROXY_VETH_NS_ADDR:-192.168.231.2/30}"

if [[ ! -d "/sys/class/net/${PARENT}" ]]; then
  echo "ssh-proxy macvlan parent missing: ${PARENT}" >&2
  exit 2
fi

if ! ip netns list | awk '{print $1}' | grep -Fxq "${NS}"; then
  ip netns add "${NS}"
fi

# Recreate links idempotently.
ip link del "${VETH_HOST}" 2>/dev/null || true
ip -n "${NS}" link del "${MV_IFACE}" 2>/dev/null || true
ip -n "${NS}" link del "${VETH_NS}" 2>/dev/null || true

ip link add "${MV_IFACE}" link "${PARENT}" type macvlan mode bridge
ip link set "${MV_IFACE}" netns "${NS}"
ip link add "${VETH_HOST}" type veth peer name "${VETH_NS}"
ip link set "${VETH_NS}" netns "${NS}"

ip addr flush dev "${VETH_HOST}" 2>/dev/null || true
ip addr add "${HOST_ADDR}" dev "${VETH_HOST}"
ip link set "${VETH_HOST}" up

ip netns exec "${NS}" bash -c "
  set -euo pipefail
  ip link set lo up
  ip addr flush dev '${MV_IFACE}' 2>/dev/null || true
  ip addr add '${MV_ADDR}' dev '${MV_IFACE}'
  ip link set '${MV_IFACE}' up
  ip addr flush dev '${VETH_NS}' 2>/dev/null || true
  ip addr add '${NS_ADDR}' dev '${VETH_NS}'
  ip link set '${VETH_NS}' up
  ip route replace default via '${HOST_ADDR%/*}' dev '${VETH_NS}'
"

# Export connection hints for the pipeline.
echo "ssh_proxy_netns=ready"
echo "E2E_SSH_PROXY_NETNS=${NS}"
echo "E2E_SSH_PROXY_HOST=${NS_ADDR%/*}"
echo "E2E_SSH_PROXY_BACKEND_WS=ws://${HOST_ADDR%/*}:3001/ws/ssh-proxy"
