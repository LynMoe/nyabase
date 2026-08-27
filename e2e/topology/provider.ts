export const topologyCapabilities = [
  'postgresql',
  'incus-https-mtls',
  'trust-token-onboarding',
  'certificate-rotation',
  'storage-dir-quota-online',
  'storage-lvm-block-backed',
  'macvlan-parent',
  'rp-filter',
  'fib-anti-spoof',
  'private-simplestreams',
  'sshd-no-dhcp-image',
  'node-exporter-authenticated-pull',
  'intent-reconciliation',
  'exec-bridge',
  'ssh-reachability',
  'gpu-pci',
  'cephfs-cluster',
] as const;

export type TopologyCapability = (typeof topologyCapabilities)[number];
export type TopologyCapabilityState = 'available' | 'blocked';
export type TopologyEvidenceBoundary = 'host-kernel' | 'cluster';

export interface TopologyCapabilityDeclaration {
  readonly state: TopologyCapabilityState;
  readonly detail: string;
}

export type TopologyCapabilityMatrix = Readonly<
  Record<TopologyCapability, TopologyCapabilityDeclaration>
>;

export const topologyLifecyclePhases = [
  'doctor',
  'build',
  'up',
  'health',
  'diagnose',
  'down',
  'run',
  'release',
] as const;

export type TopologyLifecyclePhase = (typeof topologyLifecyclePhases)[number];

export interface TopologyLifecycleEntrypoint {
  readonly path: `e2e/${string}`;
  readonly runId: 'optional' | 'required';
}

export type TopologyLifecycle = Readonly<
  Record<TopologyLifecyclePhase, TopologyLifecycleEntrypoint>
>;

export const topologyOperations = [
  'incus',
  'ssh',
  'metrics',
] as const;

export type TopologyOperation = (typeof topologyOperations)[number];

export interface TopologyOperationEntrypoint {
  readonly path: `e2e/${string}`;
}

export type TopologyOperations = Readonly<
  Record<TopologyOperation, TopologyOperationEntrypoint>
>;

export interface AvailableTopologyProvider {
  readonly implementation: 'available';
  readonly id: string;
  readonly displayName: string;
  readonly evidenceBoundary: TopologyEvidenceBoundary;
  readonly nodeCount: number;
  readonly capabilities: TopologyCapabilityMatrix;
  readonly limitations: readonly [string, ...string[]];
  readonly lifecycle: TopologyLifecycle;
  readonly operations: TopologyOperations;
}

const knownCapabilities = new Set<string>(topologyCapabilities);
const knownLifecyclePhases = new Set<string>(topologyLifecyclePhases);
const knownOperations = new Set<string>(topologyOperations);

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`Invalid topology provider: ${field} must not be empty`);
  }
}

export function assertTopologyProvider(provider: AvailableTopologyProvider): void {
  if (!/^[a-z0-9][a-z0-9-]{1,47}$/.test(provider.id)) {
    throw new Error(`Invalid topology provider id: ${provider.id}`);
  }
  assertNonEmpty(provider.displayName, 'displayName');
  if (!Number.isInteger(provider.nodeCount) || provider.nodeCount < 1) {
    throw new Error(`Invalid topology provider ${provider.id}: nodeCount must be positive`);
  }
  if (provider.limitations.length === 0) {
    throw new Error(`Invalid topology provider ${provider.id}: limitations must be explicit`);
  }
  provider.limitations.forEach((value, index) => assertNonEmpty(value, `limitations[${index}]`));

  for (const capability of topologyCapabilities) {
    const declaration = provider.capabilities[capability];
    if (!declaration || !knownCapabilities.has(capability)) {
      throw new Error(`Invalid topology provider ${provider.id}: missing ${capability}`);
    }
    assertNonEmpty(declaration.detail, `capabilities.${capability}.detail`);
    if (!['available', 'blocked'].includes(declaration.state)) {
      throw new Error(`Invalid topology provider ${provider.id}: invalid ${capability} state`);
    }
  }

  for (const phase of topologyLifecyclePhases) {
    const entrypoint = provider.lifecycle[phase];
    if (!entrypoint || !entrypoint.path.startsWith('e2e/') || entrypoint.path.includes('..')) {
      throw new Error(`Invalid topology provider ${provider.id}: lifecycle ${phase}`);
    }
  }
  for (const phase of Object.keys(provider.lifecycle)) {
    if (!knownLifecyclePhases.has(phase)) {
      throw new Error(`Invalid topology provider ${provider.id}: unknown lifecycle ${phase}`);
    }
  }

  for (const operation of topologyOperations) {
    const entrypoint = provider.operations[operation];
    if (!entrypoint || !entrypoint.path.startsWith('e2e/') || entrypoint.path.includes('..')) {
      throw new Error(`Invalid topology provider ${provider.id}: operation ${operation}`);
    }
  }
  for (const operation of Object.keys(provider.operations)) {
    if (!knownOperations.has(operation)) {
      throw new Error(`Invalid topology provider ${provider.id}: unknown operation ${operation}`);
    }
  }
}

export function defineTopologyProvider<const T extends AvailableTopologyProvider>(provider: T): T {
  assertTopologyProvider(provider);
  return provider;
}

export function supportsTopologyCapability(
  provider: AvailableTopologyProvider,
  capability: TopologyCapability,
): boolean {
  return provider.capabilities[capability].state === 'available';
}

export function requireTopologyCapabilities(
  provider: AvailableTopologyProvider,
  required: readonly TopologyCapability[],
): void {
  const missing = required.filter((capability) => (
    provider.capabilities[capability].state !== 'available'
  ));
  if (missing.length > 0) {
    const details = missing
      .map((capability) => `${capability}: ${provider.capabilities[capability].detail}`)
      .join('; ');
    throw new Error(`E2E topology is BLOCKED: ${provider.id} lacks ${details}`);
  }
}
