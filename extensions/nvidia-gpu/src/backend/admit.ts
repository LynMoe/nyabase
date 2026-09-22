import { NVIDIA_GPU_EXTENSION_ID } from '../id.js';
import {
  NVIDIA_GPU_RUNTIME_UNAVAILABLE,
  PackageHttpError,
} from '../errors.js';
import { canonicalPciAddress } from '../pci.js';
import {
  parseContainerState,
  parseCreatePciAddresses,
  parseMutatePciAddresses,
  zNvidiaGpuGrant,
  type NvidiaGpuContainerState,
  type NvidiaGpuGrant,
} from '../schema.js';
import type {
  ContainerExtensionContext,
  ExtensionGrantView,
  ServerCardExtensionContext,
} from '../types.js';

function runtimeReadyFromHealth(health: Record<string, unknown>): boolean | null {
  if (!('runtimeReady' in health) || health.runtimeReady === undefined || health.runtimeReady === null) {
    return null;
  }
  return health.runtimeReady === true;
}

function pciListsEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

export function grantFromView(grant: ExtensionGrantView): NvidiaGpuGrant {
  const payload = grant.extensionGrants?.[NVIDIA_GPU_EXTENSION_ID];
  if (payload === undefined) {
    return { pciAddresses: [] };
  }
  return parseNvidiaGpuGrant(payload);
}

export function parseNvidiaGpuGrant(payload: unknown): NvidiaGpuGrant {
  const parsed = zNvidiaGpuGrant.safeParse(payload);
  if (!parsed.success) {
    throw new PackageHttpError(400, 'INVALID_INPUT', 'nvidia-gpu grant payload is invalid');
  }
  return parsed.data;
}

export function assertNvidiaGpuGrant(
  grant: NvidiaGpuGrant,
  addresses: readonly string[],
): void {
  if (addresses.length === 0) return;
  if (grant.pciAddresses.length === 0) {
    throw new PackageHttpError(
      403,
      'PERMISSION_DENIED',
      'The server grant does not include GPU access',
    );
  }
  const allowed = new Set(
    grant.pciAddresses.flatMap((address) => {
      const canonical = canonicalPciAddress(address);
      return canonical ? [canonical] : [];
    }),
  );
  const denied = addresses.find((address) => !allowed.has(address));
  if (denied) {
    throw new PackageHttpError(
      403,
      'PERMISSION_DENIED',
      'The requested GPU is outside the server grant',
      { pciAddress: denied },
    );
  }
}

async function assertUnoccupied(
  ctx: { claims: ServerCardExtensionContext['claims']; containerId?: string },
  addresses: readonly string[],
): Promise<void> {
  if (addresses.length === 0) return;
  const occupied = new Set(await ctx.claims.listOccupiedKeys(ctx.containerId));
  const collision = addresses.find((address) => occupied.has(address));
  if (collision) {
    throw new PackageHttpError(
      409,
      'EXTENSION_DEVICE_CLAIMED',
      'A requested GPU is already claimed',
      { deviceKey: collision },
    );
  }
}

export async function admitNvidiaGpuCreate(
  ctx: ServerCardExtensionContext & {
    readonly containerId: string;
    readonly payload: unknown;
    readonly enabled: boolean;
  },
): Promise<{ readonly state: Record<string, unknown> }> {
  if (!ctx.enabled) {
    if (ctx.payload === undefined) return { state: {} };
    throw new PackageHttpError(
      409,
      'EXTENSION_NOT_ENABLED',
      'The nvidia-gpu extension is not enabled on this server',
    );
  }

  const pciAddresses = parseCreatePciAddresses(ctx.payload);
  const ready = runtimeReadyFromHealth(await ctx.health.read());

  if (pciAddresses.length > 0 && ready === false) {
    throw new PackageHttpError(
      409,
      NVIDIA_GPU_RUNTIME_UNAVAILABLE,
      'GPU runtime is not available on the server',
      { serverId: ctx.serverId },
    );
  }

  if (pciAddresses.length > 0 && !ctx.actor.admin) {
    assertNvidiaGpuGrant(grantFromView(ctx.grant), pciAddresses);
  }
  await assertUnoccupied(ctx, pciAddresses);
  await ctx.claims.replace(pciAddresses);

  if (pciAddresses.length > 0) {
    return { state: { nvidiaRuntime: true, pciAddresses } };
  }
  return {
    state: {
      nvidiaRuntime: ready === true,
      pciAddresses: [],
    },
  };
}

export async function mutateNvidiaGpuContainer(
  ctx: ContainerExtensionContext & {
    readonly payload: unknown;
    readonly enabled: boolean;
  },
): Promise<{
  readonly state: Record<string, unknown>;
  readonly requestSummary: Record<string, unknown>;
}> {
  if (!ctx.enabled) {
    throw new PackageHttpError(
      409,
      'EXTENSION_NOT_ENABLED',
      'The nvidia-gpu extension is not enabled on this server',
    );
  }

  const pciAddresses = parseMutatePciAddresses(ctx.payload);
  const current = parseContainerState(ctx.currentExtensions[NVIDIA_GPU_EXTENSION_ID]);
  if (!current && pciAddresses.length === 0) {
    await ctx.claims.replace([]);
    return {
      state: {},
      requestSummary: {
        extensionId: NVIDIA_GPU_EXTENSION_ID,
        operation: 'devices',
        pciAddresses: [],
      },
    };
  }
  const previous = current ?? { nvidiaRuntime: false, pciAddresses: [] satisfies string[] };
  const nextRuntime = pciAddresses.length > 0 ? true : previous.nvidiaRuntime;
  const assignmentChanged = previous.nvidiaRuntime !== nextRuntime
    || !pciListsEqual(previous.pciAddresses, pciAddresses);

  if (assignmentChanged && ctx.observedStatus !== 'stopped') {
    throw new PackageHttpError(
      409,
      'EXTENSION_MUTATION_REQUIRES_STOP',
      'GPU assignment changes require a stopped container',
    );
  }

  const ready = runtimeReadyFromHealth(await ctx.health.read());
  if (pciAddresses.length > 0 && ready === false) {
    throw new PackageHttpError(
      409,
      NVIDIA_GPU_RUNTIME_UNAVAILABLE,
      'GPU runtime is not available on the server',
      { serverId: ctx.serverId },
    );
  }

  if (pciAddresses.length > 0 && !ctx.actor.admin) {
    assertNvidiaGpuGrant(grantFromView(ctx.grant), pciAddresses);
  }
  await assertUnoccupied(ctx, pciAddresses);
  await ctx.claims.replace(pciAddresses);

  const state: NvidiaGpuContainerState = {
    nvidiaRuntime: nextRuntime,
    pciAddresses,
  };
  return {
    state,
    requestSummary: {
      extensionId: NVIDIA_GPU_EXTENSION_ID,
      operation: 'devices',
      pciAddresses,
    },
  };
}
