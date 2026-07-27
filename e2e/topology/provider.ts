export const topologyCapabilities = [
  'fresh-control-plane',
  'tls-edge',
  'victoria-metrics',
  'local-tls-registry',
  'two-cpu-nodes',
  'real-systemd',
  'agent-managed-dockerd',
  'cgroup-v2',
  'xfs-project-quota',
  'mount-namespaces',
  'network-namespaces',
  'shared-macvlan-l2',
  'nfs-fixture',
  'cephfs-fixture',
  'ssh-proxy',
  'http-proxy',
  'agent-inventory-faults',
  'fault-injection',
  'physical-nic',
  'physical-switch',
  'bare-metal-boot',
  'kernel-matrix',
] as const;

export type TopologyCapability = (typeof topologyCapabilities)[number];
export type TopologyCapabilityState = 'available' | 'unavailable' | 'planned';
export type TopologyEvidenceBoundary = 'shared-host-kernel' | 'physical-host';

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
] as const;

export type TopologyLifecyclePhase = (typeof topologyLifecyclePhases)[number];

export interface TopologyLifecycleEntrypoint {
  /** Repository-root-relative executable path. */
  readonly path: `e2e/${string}`;
  readonly runId: 'optional' | 'required';
}

export type TopologyLifecycle = Readonly<
  Record<TopologyLifecyclePhase, TopologyLifecycleEntrypoint>
>;

export const topologyOperations = [
  'independentNetworkClient',
  'faultControl',
  'containerSshClient',
  'remoteStorageControl',
  'storageFixtureControl',
  'proxyClientControl',
] as const;
export type TopologyOperation = (typeof topologyOperations)[number];

export const topologyNodeKeys = ['node1', 'node2'] as const;
export type TopologyNodeKey = (typeof topologyNodeKeys)[number];

export type ContainerSshClientInput = Readonly<{
  runId: string;
  nodeKey: TopologyNodeKey;
  containerId: string;
  runtimeId: string;
  expectedIp: string;
  expectedHostKeyFingerprint: string;
  expectedClientKeyFingerprint: string;
  /** One-use private key. It is sent on stdin and must never be returned. */
  privateKey: string;
  /** Strictly bounded data printed by a fixed remote command. */
  marker: string;
}>;

export interface ContainerSshClientResult {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly nodeKey: TopologyNodeKey;
  readonly sourceContainerName: string;
  readonly sourceIp: string;
  readonly probeContainerName: string;
  readonly targetContainerName: string;
  readonly serverId: string;
  readonly containerId: string;
  readonly runtimeId: string;
  readonly targetIp: string;
  readonly remoteUser: 'root';
  readonly remotePort: 22;
  readonly clientKeyFingerprint: string;
  readonly hostKeyFingerprint: string;
  readonly marker: string;
  readonly authenticated: true;
  readonly privateKeyMode: '600';
  readonly privateKeyRemoved: true;
  readonly observedAt: string;
}

export type RemoteStorageControlInput = Readonly<{
  runId: string;
  nodeKey: TopologyNodeKey;
  mountId: string;
  fsType: 'nfs' | 'cephfs';
  action: 'probe' | 'write' | 'read' | 'holdBusy' | 'releaseBusy';
  /** Required only by write/read; content is a bounded non-secret proof token. */
  marker?: string;
}>;

export interface RemoteStorageControlResult {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly nodeKey: TopologyNodeKey;
  readonly nodeContainerName: string;
  readonly mountId: string;
  readonly mountPoint: string;
  readonly action: RemoteStorageControlInput['action'];
  readonly mounted: boolean;
  readonly observedFsType: 'nfs' | 'nfs4' | 'ceph' | null;
  readonly source: string | null;
  readonly markerMatched: boolean | null;
  readonly busyPid: number | null;
  readonly cephSecretArtifactsAbsent: boolean;
  readonly observedAt: string;
}

export type StorageFixtureControlInput = Readonly<{
  runId: string;
  fixture: 'nfs';
  action: 'stop' | 'start' | 'probe';
}>;

export interface StorageFixtureControlResult {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly fixture: StorageFixtureControlInput['fixture'];
  readonly action: StorageFixtureControlInput['action'];
  readonly fixtureContainerName: string;
  readonly fixtureIp: string;
  readonly running: boolean;
  readonly portReady: boolean;
  readonly observedAt: string;
}

type ProxySshTargetInput = Readonly<{
  runId: string;
  nodeKey: TopologyNodeKey;
  containerName: string;
  marker: string;
}>;

type ProxyHttpTargetInput = Readonly<{
  runId: string;
  hostname: string;
  marker: string;
}>;

export type ProxyClientControlInput =
  | Readonly<{ runId: string; action: 'sshHostKey' | 'sshHoldProbe' | 'sshHoldRelease' }>
  | (ProxySshTargetInput & Readonly<{
      action: 'sshExec' | 'sftpRoundTrip' | 'sshHoldStart';
    }>)
  | (ProxyHttpTargetInput & Readonly<{ action: 'httpGet' | 'websocketEcho' }>);

export interface ProxyClientControlResult {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly action: ProxyClientControlInput['action'];
  readonly source: 'host-default-openssh';
  readonly sshProxyIp: string;
  readonly httpProxyIp: string;
  readonly login: string | null;
  readonly hostname: string | null;
  readonly hostKeyFingerprint: string | null;
  readonly markerMatched: boolean | null;
  readonly httpStatus: number | null;
  readonly sftpBytes: number | null;
  readonly sftpSha256: string | null;
  readonly holdPid: number | null;
  readonly holdAlive: boolean | null;
  readonly defaultSendEnv: readonly string[] | null;
  readonly observedAt: string;
}

export type AgentServiceFaultControlInput = Readonly<{
  fault: 'agentService';
  runId: string;
  nodeKey: TopologyNodeKey;
  action: 'stop' | 'start' | 'restart' | 'probe';
}>;

export type LocalDataDirOrphanFaultControlInput = Readonly<{
  fault: 'localDataDirOrphan';
  runId: string;
  nodeKey: TopologyNodeKey;
  action: 'inject' | 'probe' | 'restore';
}>;

export type DuplicateNetworkClaimFaultControlInput =
  | Readonly<{
      fault: 'duplicateNetworkClaim';
      runId: string;
      action: 'inject';
      serverId: string;
      /** One-use registration secret. It is sent on stdin and never returned. */
      agentToken: string;
    }>
  | Readonly<{
      fault: 'duplicateNetworkClaim';
      runId: string;
      action: 'probe' | 'restore';
      serverId: string;
    }>;

export type ContainerRuntimeDriftFaultControlInput = Readonly<{
  fault: 'containerRuntimeDrift';
  runId: string;
  nodeKey: TopologyNodeKey;
  action: 'remove' | 'stop' | 'start' | 'probe';
  containerId: string;
  runtimeId: string;
}>;

export type AgentTaskWireFaultMode =
  | 'drop-terminal-once'
  | 'hold-terminal-until-release'
  | 'mutate-image-ref-once';

export type AgentTaskWireFaultControlInput = Readonly<{
  fault: 'agentTaskWire';
  runId: string;
  nodeKey: TopologyNodeKey;
  mode: AgentTaskWireFaultMode;
  action: 'inject' | 'probe' | 'release' | 'restore';
  taskId: string;
  payloadHash: string;
}>;

export type BackendServiceFaultControlInput = Readonly<{
  fault: 'backendService';
  runId: string;
  action: 'restart' | 'probe';
  /** Omitted means a combined cold restart of all split runtimes. */
  role?: 'api' | 'gateway' | 'worker' | 'all';
}>;

export type BackendClockFaultControlInput = Readonly<{
  fault: 'backendClock';
  runId: string;
  action: 'advance' | 'restore' | 'probe';
}>;

export type RedisServiceFaultControlInput = Readonly<{
  fault: 'redisService';
  runId: string;
  action: 'stop' | 'flush' | 'restart' | 'probe';
}>;

export type TelemetryServiceFaultControlInput = Readonly<{
  fault: 'telemetryService';
  runId: string;
  service: 'vmagent' | 'victoriametrics';
  action: 'stop' | 'start' | 'restart' | 'probe';
}>;

export type DockerdServiceFaultControlInput = Readonly<{
  fault: 'dockerdService';
  runId: string;
  nodeKey: TopologyNodeKey;
  action: 'restart' | 'probe';
}>;

export type DuplicateAgentSessionFaultControlInput = Readonly<{
  fault: 'duplicateAgentSession';
  runId: string;
  nodeKey: TopologyNodeKey;
  action: 'probe';
}>;

export type SplitGatewaySessionRaceFaultControlInput =
  | Readonly<{
      fault: 'splitGatewaySessionRace';
      runId: string;
      nodeKey: TopologyNodeKey;
      action: 'inject';
      staleExecSessionId: string;
    }>
  | Readonly<{
      fault: 'splitGatewaySessionRace';
      runId: string;
      nodeKey: TopologyNodeKey;
      action: 'probe';
      expectedClosedExecSessionIds?: readonly string[];
    }>
  | Readonly<{
      fault: 'splitGatewaySessionRace';
      runId: string;
      nodeKey: TopologyNodeKey;
      action: 'restore';
    }>;

export type ArtifactAuditFaultControlInput = Readonly<{
  fault: 'artifactAudit';
  runId: string;
  action: 'capture';
}>;

/** Closed provider-owned fault vocabulary; callers cannot supply commands or paths. */
export type TopologyFaultControlInput =
  | AgentServiceFaultControlInput
  | LocalDataDirOrphanFaultControlInput
  | DuplicateNetworkClaimFaultControlInput
  | AgentTaskWireFaultControlInput
  | ContainerRuntimeDriftFaultControlInput
  | BackendServiceFaultControlInput
  | BackendClockFaultControlInput
  | RedisServiceFaultControlInput
  | TelemetryServiceFaultControlInput
  | DockerdServiceFaultControlInput
  | DuplicateAgentSessionFaultControlInput
  | SplitGatewaySessionRaceFaultControlInput
  | ArtifactAuditFaultControlInput;

interface TopologyFaultControlResultBase {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly observedAt: string;
}

export interface AgentServiceFaultControlResult extends TopologyFaultControlResultBase {
  readonly fault: 'agentService';
  readonly nodeKey: TopologyNodeKey;
  readonly containerName: string;
  readonly action: AgentServiceFaultControlInput['action'];
  readonly serviceActive: boolean;
  /** Probe-only full identities from the private daemon; mutations return strict null. */
  readonly runtimeContainerIds: readonly string[] | null;
  /** Probe-only running identities from the private daemon; mutations return strict null. */
  readonly activeRuntimeContainerIds: readonly string[] | null;
}

export interface LocalDataDirOrphanFaultControlResult extends TopologyFaultControlResultBase {
  readonly fault: 'localDataDirOrphan';
  readonly nodeKey: TopologyNodeKey;
  readonly containerName: string;
  readonly action: LocalDataDirOrphanFaultControlInput['action'];
  readonly resourceId: string;
  readonly sourceId: string;
  readonly sourceIdentity: string;
  readonly hostPath: string;
  readonly present: boolean;
  readonly serviceActive: boolean;
}

export interface DuplicateNetworkClaimFaultControlResult extends TopologyFaultControlResultBase {
  readonly fault: 'duplicateNetworkClaim';
  readonly action: DuplicateNetworkClaimFaultControlInput['action'];
  readonly containerName: string;
  readonly serverId: string;
  readonly conflictingAddress: string;
  readonly present: boolean;
  readonly serviceActive: boolean;
}

export interface ContainerRuntimeDriftFaultControlResult extends TopologyFaultControlResultBase {
  readonly fault: 'containerRuntimeDrift';
  readonly action: ContainerRuntimeDriftFaultControlInput['action'];
  readonly nodeKey: TopologyNodeKey;
  readonly containerName: string;
  readonly containerId: string;
  readonly runtimeId: string;
  readonly serverId: string;
  readonly physicalAbsent: boolean;
  readonly physicalRunning: boolean;
}

export interface AgentTaskWireFaultControlResult extends TopologyFaultControlResultBase {
  readonly fault: 'agentTaskWire';
  readonly action: AgentTaskWireFaultControlInput['action'];
  readonly mode: AgentTaskWireFaultMode;
  readonly nodeKey: TopologyNodeKey;
  readonly containerName: string;
  readonly taskId: string;
  readonly payloadHash: string;
  readonly serviceActive: boolean;
  readonly proxyActive: boolean;
  readonly routeActive: boolean;
  readonly released: boolean;
  readonly executeCount: number;
  readonly terminalCount: number;
  readonly droppedCount: number;
  readonly mutatedCount: number;
  readonly forwardedTerminalCount: number;
  readonly firstExecuteAt: string | null;
  readonly lastExecuteAt: string | null;
  readonly firstTerminalAt: string | null;
  readonly lastForwardedTerminalAt: string | null;
}

export interface BackendServiceFaultControlResult extends TopologyFaultControlResultBase {
  readonly fault: 'backendService';
  readonly action: BackendServiceFaultControlInput['action'];
  readonly role: 'api' | 'gateway' | 'worker' | 'all';
  readonly containerName: string;
  readonly containerId: string;
  readonly runtimes: readonly Readonly<{
    role: 'api' | 'gateway' | 'worker';
    containerName: string;
    containerId: string;
    generation: string;
  }>[];
  readonly before: { readonly generation: string; readonly healthy: true };
  readonly after: { readonly generation: string; readonly healthy: true };
  readonly restarted: boolean;
}

export interface BackendClockFaultControlResult extends TopologyFaultControlResultBase {
  readonly fault: 'backendClock';
  readonly action: BackendClockFaultControlInput['action'];
  readonly containerName: string;
  readonly offsetMs: 0 | 691200000;
  readonly generation: string;
  readonly healthy: true;
}

export interface RedisServiceFaultControlResult extends TopologyFaultControlResultBase {
  readonly fault: 'redisService';
  readonly action: RedisServiceFaultControlInput['action'];
  readonly containerName: string;
  readonly containerId: string;
  readonly generation: string;
  readonly running: boolean;
  readonly healthy: boolean;
  readonly keyCount: number;
  readonly flushed: boolean;
  readonly persistenceDisabled: true;
}

export interface TelemetryServiceFaultControlResult extends TopologyFaultControlResultBase {
  readonly fault: 'telemetryService';
  readonly service: TelemetryServiceFaultControlInput['service'];
  readonly action: TelemetryServiceFaultControlInput['action'];
  readonly containerName: string;
  readonly containerId: string;
  readonly generation: string;
  readonly healthy: boolean;
  /** vmagent's own bounded persistent-queue backlog; null for VM or stopped vmagent. */
  readonly queuePendingBytes: number | null;
}

export interface DockerdServiceFaultControlResult extends TopologyFaultControlResultBase {
  readonly fault: 'dockerdService';
  readonly action: DockerdServiceFaultControlInput['action'];
  readonly nodeKey: TopologyNodeKey;
  readonly containerName: string;
  readonly beforeGeneration: string;
  readonly afterGeneration: string;
  readonly serviceActive: true;
  readonly runtimeContainerIdsBefore: readonly string[];
  readonly runtimeContainerIdsAfter: readonly string[];
  readonly activeRuntimeContainerIdsAfter: readonly string[];
}

export interface DuplicateAgentSessionFaultControlResult extends TopologyFaultControlResultBase {
  readonly fault: 'duplicateAgentSession';
  readonly action: 'probe';
  readonly nodeKey: TopologyNodeKey;
  readonly serverId: string;
  readonly opened: true;
  readonly admissionReceived: false;
  readonly closed: true;
}

export interface SplitGatewaySessionRaceFaultControlResult
  extends TopologyFaultControlResultBase {
  readonly fault: 'splitGatewaySessionRace';
  readonly action: SplitGatewaySessionRaceFaultControlInput['action'];
  readonly nodeKey: TopologyNodeKey;
  readonly serverId: string;
  readonly primaryGatewayContainer: string;
  readonly secondaryGatewayContainer: string;
  readonly secondaryEdgeContainer: string;
  readonly secondaryEdgeHostPort: number;
  readonly secondaryConsoleUrl: string;
  readonly primaryGatewayProcessGeneration: string;
  readonly baselineGatewayId: string;
  readonly ownerGatewayId: string;
  readonly ownerSessionId: string;
  readonly ownerGeneration: number;
  readonly serverOnline: true;
  readonly runtimeReady: true;
  readonly primaryGatewayActive: true;
  readonly primaryGatewayPaused: false;
  readonly delayedPrimaryCleanupReleased: true;
  readonly secondaryGatewayActive: boolean;
  readonly secondaryEdgeActive: boolean;
  readonly secondaryEdgeHostPortActive: boolean;
  readonly secondaryEdgeHostPortOwned: boolean;
  readonly routeActive: boolean;
  readonly cleanupComplete: boolean;
  readonly closedExecSessions: readonly Readonly<{
    sessionId: string;
    state: 'closed';
    closedAt: string;
    closeReason: string;
    agentSessionId: string;
    gatewayId: string;
  }>[];
}

export interface ArtifactAuditFaultControlResult extends TopologyFaultControlResultBase {
  readonly fault: 'artifactAudit';
  readonly action: 'capture';
  readonly evidencePath: string;
  readonly evidenceSha256: string;
  readonly status: 'clean';
  readonly playwrightArtifactPolicy: 'pre-report-empty';
  readonly filesChecked: number;
  readonly knownSecretsChecked: number;
}

export type TopologyFaultControlResult =
  | AgentServiceFaultControlResult
  | LocalDataDirOrphanFaultControlResult
  | DuplicateNetworkClaimFaultControlResult
  | AgentTaskWireFaultControlResult
  | ContainerRuntimeDriftFaultControlResult
  | BackendServiceFaultControlResult
  | BackendClockFaultControlResult
  | RedisServiceFaultControlResult
  | TelemetryServiceFaultControlResult
  | DockerdServiceFaultControlResult
  | DuplicateAgentSessionFaultControlResult
  | SplitGatewaySessionRaceFaultControlResult
  | ArtifactAuditFaultControlResult;

export interface TopologyOperationEntrypoint {
  /** Repository-root-relative provider operation used through a typed support adapter. */
  readonly path: `e2e/${string}`;
}

export type TopologyOperations = Readonly<Record<TopologyOperation, TopologyOperationEntrypoint>>;

interface TopologyProviderBase {
  /** Stable CLI/config identifier. */
  readonly id: string;
  readonly displayName: string;
  readonly evidenceBoundary: TopologyEvidenceBoundary;
  readonly nodeCount: number;
  /** Every capability is explicit so specs cannot infer support from a provider name. */
  readonly capabilities: TopologyCapabilityMatrix;
  readonly limitations: readonly [string, ...string[]];
}

export interface AvailableTopologyProvider extends TopologyProviderBase {
  readonly implementation: 'available';
  readonly lifecycle: TopologyLifecycle;
  readonly operations: TopologyOperations;
}

export interface FutureTopologyProvider extends TopologyProviderBase {
  readonly implementation: 'future';
  readonly lifecycle: null;
  readonly operations: null;
}

export type TopologyProvider = AvailableTopologyProvider | FutureTopologyProvider;

const knownCapabilities = new Set<string>(topologyCapabilities);
const knownLifecyclePhases = new Set<string>(topologyLifecyclePhases);
const knownOperations = new Set<string>(topologyOperations);

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`Invalid topology provider: ${field} must not be empty`);
  }
}

/**
 * Runtime validation complements `satisfies TopologyProvider` for descriptors
 * loaded or assembled from data. It intentionally does not probe a live host.
 */
export function assertTopologyProvider(provider: TopologyProvider): void {
  const providerId = provider.id;
  if (!/^[a-z0-9][a-z0-9-]{1,47}$/.test(provider.id)) {
    throw new Error(`Invalid topology provider id: ${provider.id}`);
  }
  assertNonEmpty(provider.displayName, 'displayName');
  if (!Number.isInteger(provider.nodeCount) || provider.nodeCount < 1) {
    throw new Error(
      `Invalid topology provider ${provider.id}: nodeCount must be a positive integer`,
    );
  }
  if (provider.limitations.length === 0) {
    throw new Error(`Invalid topology provider ${provider.id}: limitations must be explicit`);
  }
  provider.limitations.forEach((limitation, index) => {
    assertNonEmpty(limitation, `limitations[${index}]`);
  });

  const capabilityKeys = Object.keys(provider.capabilities);
  for (const capability of topologyCapabilities) {
    const declaration = provider.capabilities[capability];
    if (!declaration) {
      throw new Error(`Invalid topology provider ${provider.id}: missing capability ${capability}`);
    }
    assertNonEmpty(declaration.detail, `capabilities.${capability}.detail`);
    if (!['available', 'unavailable', 'planned'].includes(declaration.state)) {
      throw new Error(
        `Invalid topology provider ${provider.id}: unknown state for capability ${capability}`,
      );
    }
  }
  for (const capability of capabilityKeys) {
    if (!knownCapabilities.has(capability)) {
      throw new Error(`Invalid topology provider ${provider.id}: unknown capability ${capability}`);
    }
  }

  if (provider.implementation === 'future') {
    if (provider.lifecycle !== null || provider.operations !== null) {
      throw new Error(
        `Invalid future topology provider ${providerId}: lifecycle and operations must be null`,
      );
    }
    const prematurelyAvailable = topologyCapabilities.filter(
      (capability) => provider.capabilities[capability].state === 'available',
    );
    if (prematurelyAvailable.length > 0) {
      throw new Error(
        `Invalid future topology provider ${provider.id}: capabilities cannot be available: ${prematurelyAvailable.join(', ')}`,
      );
    }
    return;
  }

  const lifecycleKeys = Object.keys(provider.lifecycle);
  for (const phase of topologyLifecyclePhases) {
    const entrypoint = provider.lifecycle[phase];
    if (!entrypoint) {
      throw new Error(`Invalid topology provider ${provider.id}: missing lifecycle phase ${phase}`);
    }
    if (!entrypoint.path.startsWith('e2e/') || entrypoint.path.includes('..')) {
      throw new Error(
        `Invalid topology provider ${provider.id}: ${phase} must use a repository-relative e2e path`,
      );
    }
  }
  for (const phase of lifecycleKeys) {
    if (!knownLifecyclePhases.has(phase)) {
      throw new Error(`Invalid topology provider ${provider.id}: unknown lifecycle phase ${phase}`);
    }
  }

  const operationKeys = Object.keys(provider.operations);
  for (const operation of topologyOperations) {
    const entrypoint = provider.operations[operation];
    if (!entrypoint) {
      throw new Error(`Invalid topology provider ${provider.id}: missing operation ${operation}`);
    }
    if (!entrypoint.path.startsWith('e2e/') || entrypoint.path.includes('..')) {
      throw new Error(
        `Invalid topology provider ${provider.id}: operation ${operation} must use a repository-relative e2e path`,
      );
    }
  }
  for (const operation of operationKeys) {
    if (!knownOperations.has(operation)) {
      throw new Error(`Invalid topology provider ${provider.id}: unknown operation ${operation}`);
    }
  }
}

export function defineTopologyProvider<const T extends TopologyProvider>(provider: T): T {
  assertTopologyProvider(provider);
  return provider;
}

export function supportsTopologyCapability(
  provider: TopologyProvider,
  capability: TopologyCapability,
): boolean {
  return (
    provider.implementation === 'available' &&
    provider.capabilities[capability].state === 'available'
  );
}

/** Missing infrastructure is BLOCKED by contract, never an implicit skip. */
export function requireTopologyCapabilities(
  provider: TopologyProvider,
  required: readonly TopologyCapability[],
): void {
  if (provider.implementation !== 'available') {
    throw new Error(`E2E topology is BLOCKED: provider ${provider.id} is future-only`);
  }

  const missing = required.filter(
    (capability) => provider.capabilities[capability].state !== 'available',
  );
  if (missing.length > 0) {
    const details = missing
      .map((capability) => `${capability}: ${provider.capabilities[capability].detail}`)
      .join('; ');
    throw new Error(`E2E topology is BLOCKED: provider ${provider.id} lacks ${details}`);
  }
}
