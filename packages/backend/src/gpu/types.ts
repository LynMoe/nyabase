/** Incus GET /1.0/resources metadata. Parsed inside the gpu feature. */
export type IncusResourcesMetadata = unknown;

export interface GpuClaimsPort {
  /** Replace this container's claimed PCI addresses (container-scoped ports only). */
  replace(pciAddresses: readonly string[]): Promise<void>;
  /** PCI addresses claimed on the server by other containers. */
  listOccupied(excludeContainerId?: string): Promise<string[]>;
  count(): Promise<number>;
}

export interface GpuHealthPort {
  /** Persisted health; may omit runtimeReady. */
  read(): Promise<Record<string, unknown>>;
  write(health: Record<string, unknown>): Promise<void>;
}

export interface GpuActor {
  readonly userId: string;
  readonly admin: boolean;
}

export interface GpuContext {
  readonly serverId: string;
  readonly actor: GpuActor;
  /** Canonical PCI addresses allowed by the actor's server grant; empty means none. */
  readonly grantPciAddresses: readonly string[];
  readonly claims: GpuClaimsPort;
  readonly health: GpuHealthPort;
}
