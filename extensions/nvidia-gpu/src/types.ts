import type {
  ExtensionSupportDto,
  NodeMetricDefinition,
  NodeMetricSample,
} from '@nyabase/common';
import type { nvidiaGpuFormatError } from './errors.js';

/** Incus GET /1.0/resources metadata. Parsed inside the package. */
export type IncusResourcesMetadata = unknown;

export interface NodeMetricCatalog {
  readonly definitions: Readonly<Record<string, NodeMetricDefinition>>;
  readonly validators: Readonly<
    Record<string, (labels: Readonly<Record<string, string>>) => Record<string, string>>
  >;
}

export interface ManagedFieldsDiff {
  readonly config: Readonly<Record<string, unknown>>;
  readonly devices: Readonly<Record<string, unknown>>;
}

export interface ExtensionClaimsPort {
  replace(deviceKeys: readonly string[]): Promise<void>;
  listOccupiedKeys(excludeContainerId?: string): Promise<string[]>;
  count(): Promise<number>;
}

export interface ExtensionHealthPort {
  read(): Promise<Record<string, unknown>>;
  write(health: Record<string, unknown>): Promise<void>;
}

export interface ExtensionActor {
  readonly userId: string;
  readonly admin: boolean;
}

export interface ExtensionGrantView {
  readonly extensionGrants: Readonly<Record<string, unknown>> | null;
}

export interface ServerCardExtensionContext {
  readonly serverId: string;
  readonly actor: ExtensionActor;
  readonly grant: ExtensionGrantView;
  readonly claims: ExtensionClaimsPort;
  readonly health: ExtensionHealthPort;
}

export interface ContainerExtensionContext extends ServerCardExtensionContext {
  readonly containerId: string;
  readonly lifecyclePhase: 'provisioning' | 'active' | 'deleting' | 'failed';
  readonly powerIntent: 'running' | 'stopped';
  readonly observedStatus: 'running' | 'stopped' | 'frozen' | 'error' | 'unknown';
  readonly currentExtensions: Readonly<Record<string, unknown>>;
}

export interface InstanceSpecContribution {
  readonly config: Readonly<Record<string, string>>;
  readonly devices: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export interface PreflightContribution {
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly health: Readonly<Record<string, unknown>>;
}

/** Registered / supported / enabled are orthogonal; health is operational. */
export interface ServerCardExtension {
  readonly id: string;
  readonly displayName: string;
  readonly ownedIncusConfigKeyPrefixes: readonly string[];
  readonly ownedIncusDeviceNamePrefixes: readonly string[];
  readonly errorFormatter: typeof nvidiaGpuFormatError;
  readonly metricCatalog?: NodeMetricCatalog;

  admitCreate(
    ctx: ServerCardExtensionContext & {
      readonly containerId: string;
      readonly payload: unknown;
      readonly enabled: boolean;
    },
  ): Promise<{ readonly state: Record<string, unknown> }>;

  mutateContainer(
    ctx: ContainerExtensionContext & {
      readonly payload: unknown;
      readonly enabled: boolean;
    },
  ): Promise<{
    readonly state: Record<string, unknown>;
    readonly requestSummary: Record<string, unknown>;
  }>;

  requiresStop(diff: ManagedFieldsDiff): boolean;

  contributeInstanceSpec(input: {
    readonly containerId: string;
    readonly serverId: string;
    readonly state: unknown;
  }): InstanceSpecContribution;

  contributePreflight(input: {
    readonly serverId: string;
    readonly resources: IncusResourcesMetadata;
    readonly metricSamples: readonly NodeMetricSample[];
    readonly enabled: boolean;
  }): Promise<PreflightContribution>;

  probeSupport(input: {
    readonly serverId: string;
    readonly resources: IncusResourcesMetadata;
    readonly metricSamples: readonly NodeMetricSample[];
  }): Promise<ExtensionSupportDto>;

  refreshHealth(input: {
    readonly health: ExtensionHealthPort;
    readonly serverId: string;
    readonly resources: IncusResourcesMetadata;
    readonly metricSamples: readonly NodeMetricSample[];
  }): Promise<void>;

  parseGrantPayload(payload: unknown): unknown;
  effectiveGrantDevices(
    grantPayload: unknown,
    inventory: readonly unknown[],
  ): readonly unknown[];

  listDevices(input: {
    readonly serverId: string;
    readonly resources: IncusResourcesMetadata;
    readonly metricSamples: readonly NodeMetricSample[];
    readonly grantPayload: unknown | null;
    readonly admin: boolean;
    readonly enabled: boolean;
  }): Promise<{ readonly items: readonly unknown[] }>;

  assertCanDisable(ctx: ServerCardExtensionContext): Promise<void>;

  purgeServer(ctx: { readonly serverId: string; readonly claims: ExtensionClaimsPort }): Promise<void>;
}
