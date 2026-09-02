import type { ExtensionErrorFormatter, NodeMetricCatalog, NodeMetricSample } from '@nyabase/common';
import type { ManagedFieldsDiff } from '../incus/compare-managed-fields.js';

/** Incus GET /1.0/resources metadata. Core passes it through unchanged. */
export type IncusResourcesMetadata = unknown;

export const SERVER_CARD_EXTENSIONS = Symbol('SERVER_CARD_EXTENSIONS');
export const NODE_METRIC_CATALOG = Symbol('NODE_METRIC_CATALOG');

export interface ExtensionClaimsPort {
  replace(deviceKeys: readonly string[]): Promise<void>;
  listOccupiedKeys(excludeContainerId?: string): Promise<string[]>;
  count(): Promise<number>;
}

export interface ExtensionHealthPort {
  /** Persisted health; may omit runtimeReady. */
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
  /**
   * Same as today's `containerStatus(route, powerIntent)`.
   * API stop gating is `observedStatus !== 'stopped'` (includes frozen).
   */
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

export interface ServerCardExtension {
  readonly id: string;
  readonly displayName: string;
  readonly ownedIncusConfigKeyPrefixes: readonly string[]; // e.g. ['example.']
  readonly ownedIncusDeviceNamePrefixes: readonly string[]; // e.g. ['ext']
  readonly errorFormatter: ExtensionErrorFormatter;
  readonly metricCatalog?: NodeMetricCatalog;

  /**
   * Called for every registered extension on create, even when the request
   * omits this key. `payload` is `request.extensions[id]` or undefined.
   * Throws PackageHttpError for core or package string codes.
   */
  admitCreate(
    ctx: ServerCardExtensionContext & {
      readonly containerId: string;
      readonly payload: unknown;
      readonly enabled: boolean;
    },
  ): Promise<{ readonly state: Record<string, unknown> }>;

  /**
   * Does not return stopRequired. If `observedStatus !== 'stopped'` and the
   * assignment needs a stop, throw EXTENSION_MUTATION_REQUIRES_STOP.
   */
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

  /**
   * Pure projection of `extensions[id]`. Missing or non-object state ⇒ empty
   * contribution. Must not apply create-time defaults.
   */
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

  /**
   * Scan, preflight, and PUT-enablement call this in the same request.
   * Writes health only; never flips enabled. Unreachable Incus ⇒ runtimeReady: null.
   */
  refreshHealth(input: {
    readonly health: ExtensionHealthPort;
    readonly serverId: string;
    readonly resources: IncusResourcesMetadata;
    readonly metricSamples: readonly NodeMetricSample[];
  }): Promise<void>;

  parseGrantPayload(payload: unknown): unknown;
  effectiveGrantDevices(grantPayload: unknown, inventory: readonly unknown[]): readonly unknown[];

  listDevices(input: {
    readonly serverId: string;
    readonly resources: IncusResourcesMetadata;
    readonly metricSamples: readonly NodeMetricSample[];
    readonly grantPayload: unknown | null;
    readonly admin: boolean;
    readonly enabled: boolean;
  }): Promise<{ readonly items: readonly unknown[] }>;

  assertCanDisable(ctx: ServerCardExtensionContext): Promise<void>;

  /** Called before the core deletes the server_extensions row. */
  purgeServer(ctx: {
    readonly serverId: string;
    readonly claims: ExtensionClaimsPort;
  }): Promise<void>;
}
