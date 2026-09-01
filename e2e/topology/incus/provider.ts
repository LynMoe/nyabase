import { readFileSync } from 'node:fs';
import {
  defineTopologyProvider,
  type TopologyCapability,
  type TopologyCapabilityDeclaration,
} from '../provider.js';

const declared = new Set(
  (process.env.E2E_CAPABILITIES ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);

const capabilityInputs: Partial<Record<TopologyCapability, string[]>> = {
  postgresql: ['E2E_DATABASE_URL'],
  'incus-https-mtls': [
    'E2E_INCUS_API_ENDPOINT',
    'E2E_INCUS_SERVER_CERT_FINGERPRINT',
    'E2E_INCUS_CLIENT_CERT',
    'E2E_INCUS_CLIENT_KEY',
    'E2E_INCUS_CA_FILE',
  ],
  'trust-token-onboarding': ['E2E_INCUS_TRUST_TOKEN'],
  'certificate-rotation': ['E2E_EDGE_CA_FILE'],
  'storage-dir-quota-online': ['E2E_INCUS_DIR_POOL'],
  'storage-lvm-block-backed': ['E2E_INCUS_LVM_POOL'],
  'lan-bridge': [
    'E2E_INCUS_PARENT_INTERFACE',
    'E2E_INCUS_ROUTED_SUBNET',
    'E2E_INCUS_ROUTED_ADDRESS',
    'E2E_INCUS_ROUTED_GATEWAY',
  ],
  'bridge-ipv4-filter': [
    'E2E_INCUS_PARENT_INTERFACE',
    'E2E_INCUS_ROUTED_SUBNET',
    'E2E_INCUS_SPOOF_ADDRESS',
  ],
  'private-simplestreams': [
    'E2E_INCUS_IMAGE_SOURCE_URL',
    'E2E_INCUS_IMAGE_REMOTE',
    'E2E_INCUS_IMAGE_ALIAS',
    'E2E_INCUS_IMAGE_FINGERPRINT',
    'E2E_INCUS_PREFLIGHT_IMAGE_ALIAS',
    'E2E_INCUS_PREFLIGHT_IMAGE_FINGERPRINT',
    'E2E_INCUS_PREFLIGHT_POOL_NAME',
    'E2E_INCUS_PREFLIGHT_EGRESS_URL',
    'E2E_INCUS_PREFLIGHT_SOURCE_SERVER',
  ],
  'sshd-no-dhcp-image': [
    'E2E_INCUS_IMAGE_REMOTE',
    'E2E_INCUS_IMAGE_ALIAS',
    'E2E_INCUS_IMAGE_FINGERPRINT',
    'E2E_INCUS_IMAGE_NO_DHCP',
  ],
  'node-exporter-authenticated-pull': [
    'E2E_NODE_EXPORTER_URL',
    'E2E_NODE_EXPORTER_TOKEN',
    'E2E_NODE_EXPORTER_SERVER_CERT_FINGERPRINT',
  ],
  'intent-reconciliation': ['E2E_BASE_URL', 'E2E_SEED_STATE'],
  'exec-bridge': ['E2E_BASE_URL', 'E2E_SEED_STATE'],
  'ssh-reachability': ['E2E_BASE_URL', 'E2E_SEED_STATE'],
};

const capabilityDetails: Record<TopologyCapability, string> = {
  postgresql: 'E2E_DATABASE_URL and a healthy PostgreSQL endpoint are required',
  'incus-https-mtls': 'Incus HTTPS, the server fingerprint, and the client certificate/key are required',
  'trust-token-onboarding': 'A one-use Incus trust token must be supplied only at onboarding time',
  'certificate-rotation': 'The edge CA and the rotation endpoint must be configured',
  'storage-dir-quota-online': 'A verified dir pool with quota= true and online resize is required',
  'storage-lvm-block-backed': 'A verified LVM pool with block-backed volumes is required',
  'lan-bridge': 'The unmanaged LAN bridge (vmbr) and LAN subnet must be verified',
  'bridge-ipv4-filter': 'nft bridge-family IPv4/ARP anti-spoof inputs must be present',
  'private-simplestreams': 'The image source must be private HTTPS simplestreams',
  'sshd-no-dhcp-image': 'The selected SSHD image must prove that DHCP is not required',
  'node-exporter-authenticated-pull': 'The exporter URL and bearer token must be configured',
  'intent-reconciliation': 'A live control-plane URL and a seeded server are required',
  'exec-bridge': 'A live control-plane URL and a seeded server are required',
  'ssh-reachability': 'A live control-plane URL and a seeded SSHD image are required',
  'gpu-pci': 'BLOCKED: no GPU PCI device is claimed by the local Incus host',
  'cephfs-cluster': 'BLOCKED: a multi-node CephFS cluster is not provisioned locally',
  'multi-server': 'BLOCKED: extra Incus workers are not listed in E2E_LAB_SERVERS_FILE',
};

function cephfsFixturePresent(): boolean {
  const sharedBackendId = process.env.E2E_SHARED_BACKEND_ID?.trim();
  const fsid = process.env.E2E_CEPHFS_FSID?.trim();
  const identityKey = process.env.E2E_CEPHFS_IDENTITY_KEY?.trim();
  const pool = process.env.E2E_CEPHFS_INCUS_POOL?.trim();
  return Boolean(sharedBackendId && fsid && identityKey && pool);
}

function labServerCount(): number {
  const path = process.env.E2E_LAB_SERVERS_FILE?.trim();
  if (!path) return 0;
  try {
    const listed = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(listed) ? listed.length : 0;
  } catch {
    return 0;
  }
}

function declaration(capability: TopologyCapability): TopologyCapabilityDeclaration {
  if (capability === 'gpu-pci') {
    const peerPci = process.env.E2E_GPU_PCI_ADDRESS?.trim();
    const peerProof = process.env.E2E_GPU_PCI_PROOF?.trim();
    if (peerPci && peerProof === '1') {
      return {
        state: 'available',
        detail: `GPU PCI proof is present for ${peerPci}`,
      };
    }
    if (declared.size > 0 && !declared.has('gpu-pci')) {
      return { state: 'blocked', detail: capabilityDetails['gpu-pci'] };
    }
    return { state: 'blocked', detail: capabilityDetails['gpu-pci'] };
  }
  if (capability === 'cephfs-cluster') {
    if (cephfsFixturePresent()) {
      return {
        state: 'available',
        detail: `shared CephFS backend ${process.env.E2E_SHARED_BACKEND_ID} pool ${process.env.E2E_CEPHFS_INCUS_POOL}`,
      };
    }
    if (declared.size > 0 && declared.has('cephfs-cluster')) {
      return {
        state: 'available',
        detail: 'doctor verified CephFS cluster capability for the current run',
      };
    }
    return { state: 'blocked', detail: capabilityDetails['cephfs-cluster'] };
  }
  if (capability === 'multi-server') {
    const extra = labServerCount();
    if (extra > 0) {
      return {
        state: 'available',
        detail: `${extra} extra Incus worker(s) listed in E2E_LAB_SERVERS_FILE`,
      };
    }
    if (declared.size > 0 && declared.has('multi-server')) {
      return {
        state: 'available',
        detail: 'doctor verified extra Incus workers for the current run',
      };
    }
    return { state: 'blocked', detail: capabilityDetails['multi-server'] };
  }
  if (declared.size > 0) {
    return declared.has(capability)
      ? { state: 'available', detail: 'doctor verified this capability for the current run' }
      : { state: 'blocked', detail: capabilityDetails[capability] };
  }
  const required = capabilityInputs[capability] ?? [];
  const available = required.every((name) => Boolean(process.env[name]?.trim()));
  return available
    ? { state: 'available', detail: 'required runtime inputs are present; doctor remains authoritative' }
    : { state: 'blocked', detail: capabilityDetails[capability] };
}

const capabilities = Object.fromEntries(
  Object.keys(capabilityDetails).map((key) => [
    key,
    declaration(key as TopologyCapability),
  ]),
) as Record<TopologyCapability, TopologyCapabilityDeclaration>;

const lifecycle = {
  doctor: { path: 'e2e/orchestrator/doctor.sh', runId: 'optional' },
  build: { path: 'e2e/orchestrator/build.sh', runId: 'optional' },
  up: { path: 'e2e/orchestrator/up.sh', runId: 'required' },
  health: { path: 'e2e/orchestrator/health.sh', runId: 'required' },
  diagnose: { path: 'e2e/orchestrator/diagnose.sh', runId: 'required' },
  down: { path: 'e2e/orchestrator/down.sh', runId: 'required' },
  run: { path: 'e2e/orchestrator/run.sh', runId: 'required' },
  release: { path: 'e2e/orchestrator/release.sh', runId: 'required' },
} as const;

const operations = {
  incus: { path: 'e2e/support/incus-control.ts' },
  ssh: { path: 'e2e/support/incus-control.ts' },
  metrics: { path: 'e2e/support/metrics-control.ts' },
} as const;

export default defineTopologyProvider({
  implementation: 'available',
  id: 'incus-standalone',
  displayName: 'Incus standalone host',
  evidenceBoundary: 'host-kernel',
  nodeCount: 1 + labServerCount(),
  capabilities,
  limitations: [
    'gpu-pci is available only when E2E_GPU_PCI_PROOF=1 and E2E_GPU_PCI_ADDRESS are set from real hardware evidence',
    'cephfs-cluster is available only when E2E_SHARED_BACKEND_ID and E2E_CEPHFS_* fixture inputs are present',
    'multi-server is available when E2E_LAB_SERVERS_FILE lists extra Incus workers',
    'bridge-ipv4-filter is available when the operator-owned vmbr and spoof address inputs are present',
    'The provider never fabricates a storage, network, image, or telemetry capability',
    'The provider requires real HTTPS/mTLS and PostgreSQL endpoints',
  ],
  lifecycle,
  operations,
});
