import { defineTopologyProvider, type TopologyProvider } from '../provider.js';

/**
 * The currently wired local provider. `available` describes provider support,
 * not a passing run: doctor/health and the live specs still have to produce
 * current-run evidence.
 */
export const dockerDindProvider = defineTopologyProvider({
  id: 'docker-dind',
  displayName: 'Docker DinD (shared host kernel)',
  implementation: 'available',
  evidenceBoundary: 'shared-host-kernel',
  nodeCount: 2,
  lifecycle: {
    doctor: { path: 'e2e/orchestrator/doctor.sh', runId: 'optional' },
    build: { path: 'e2e/orchestrator/build.sh', runId: 'required' },
    up: { path: 'e2e/orchestrator/up.sh', runId: 'required' },
    health: { path: 'e2e/orchestrator/health.sh', runId: 'required' },
    diagnose: { path: 'e2e/orchestrator/diagnose.sh', runId: 'required' },
    down: { path: 'e2e/orchestrator/down.sh', runId: 'required' },
  },
  operations: {
    independentNetworkClient: {
      path: 'e2e/orchestrator/independent-network-client.mjs',
    },
    faultControl: {
      path: 'e2e/orchestrator/fault-control.mjs',
    },
    containerSshClient: {
      path: 'e2e/orchestrator/container-ssh-client.mjs',
    },
    remoteStorageControl: {
      path: 'e2e/orchestrator/remote-storage-control.mjs',
    },
    storageFixtureControl: {
      path: 'e2e/orchestrator/storage-fixture-control.mjs',
    },
    proxyClientControl: {
      path: 'e2e/orchestrator/proxy-client-control.mjs',
    },
  },
  capabilities: {
    'fresh-control-plane': {
      state: 'available',
      detail:
        'Per-run Backend SQLite volume, TLS edge, registry, metrics service, and labelled resources.',
    },
    'tls-edge': {
      state: 'available',
      detail: 'The edge and registry use certificates generated for the current run.',
    },
    'victoria-metrics': {
      state: 'available',
      detail: 'A dedicated per-run VictoriaMetrics service is part of the Compose control plane.',
    },
    'local-tls-registry': {
      state: 'available',
      detail: 'A per-run TLS registry publishes the immutable CPU workload image.',
    },
    'two-cpu-nodes': {
      state: 'available',
      detail: 'Two privileged CPU-only node containers are created with distinct machine IDs.',
    },
    'real-systemd': {
      state: 'available',
      detail: 'Each node runs systemd as PID 1 in a container; this is not physical boot evidence.',
    },
    'agent-managed-dockerd': {
      state: 'available',
      detail: 'Each Agent owns a distinct dockerd socket and XFS-backed data root.',
    },
    'cgroup-v2': {
      state: 'available',
      detail: 'Nodes use private cgroup namespaces over the host cgroup v2 kernel.',
    },
    'xfs-project-quota': {
      state: 'available',
      detail: 'Each node provisions a loop-backed XFS filesystem mounted with project quotas.',
    },
    'mount-namespaces': {
      state: 'available',
      detail: 'Privileged node containers exercise real mounts in isolated mount namespaces.',
    },
    'network-namespaces': {
      state: 'available',
      detail: 'Outer nodes and inner workloads use real Linux network namespaces.',
    },
    'shared-macvlan-l2': {
      state: 'available',
      detail:
        'Every up run reserves .101-.199 for workloads and must pass same-node, bidirectional cross-node, and independent-client ICMP/HTTP probes with scoped cleanup.',
    },
    'nfs-fixture': {
      state: 'available',
      detail:
        'A run-owned NFSv4.2 Ganesha fixture is mounted by real kernel clients on both CPU nodes and is health-checked without changing the host NFS daemon.',
    },
    'cephfs-fixture': {
      state: 'available',
      detail:
        'A run-owned CephFS cluster with MON, MGR, BlueStore OSD, and MDS is mounted by real kernel clients on both CPU nodes with private credentials.',
    },
    'ssh-proxy': {
      state: 'available',
      detail:
        'The current-build Rust SSH proxy connects to the real Backend over WSS and is exercised by strict-host-key OpenSSH and SFTP clients.',
    },
    'http-proxy': {
      state: 'available',
      detail:
        'The current-build Rust HTTP proxy connects to the real Backend over WSS and carries real HTTP and RFC6455 WebSocket client traffic.',
    },
    'agent-inventory-faults': {
      state: 'available',
      detail:
        'A closed run-scoped operation controls the fixed Agent systemd unit and provider-owned local-data/network identity faults; arbitrary containers, paths, and commands are rejected.',
    },
    'fault-injection': {
      state: 'available',
      detail:
        'Closed run-scoped controls exercise Backend and dockerd restart, process-clock retention, Agent reconnect/session fencing, exact task-wire replay/result faults, runtime drift, inventory fail-stop, and artifact auditing.',
    },
    'physical-nic': {
      state: 'unavailable',
      detail: 'Container networking cannot certify physical NIC behavior.',
    },
    'physical-switch': {
      state: 'unavailable',
      detail:
        'Container networking cannot certify switch port security, VLAN policy, or physical MTU.',
    },
    'bare-metal-boot': {
      state: 'unavailable',
      detail: 'Container systemd startup is not evidence of firmware or bare-metal boot behavior.',
    },
    'kernel-matrix': {
      state: 'unavailable',
      detail: 'All nodes share one host kernel, so this provider cannot certify a kernel matrix.',
    },
  },
  limitations: [
    'All node workloads share the Docker host kernel.',
    'Results do not prove physical NIC, switch, VLAN, MTU, firmware, or bare-metal boot behavior.',
    'Storage and proxy fixtures are run-owned containers; they certify product behavior on the shared host kernel, not external appliance interoperability.',
  ],
} as const satisfies TopologyProvider);

export default dockerDindProvider;
