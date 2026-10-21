import {
  FailureCode,
  canonicalPciAddress,
  parseContainerState,
  type GpuContainerState,
} from '@nyabase/common';
import { gpuConflict, gpuForbidden } from './gpu-errors.js';
import { parseMutatePciAddresses, parsePciAddressList } from './pci-input.js';
import type { GpuContext } from './types.js';

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

export function assertGpuGrant(
  grantPciAddresses: readonly string[],
  addresses: readonly string[],
): void {
  if (addresses.length === 0) return;
  if (grantPciAddresses.length === 0) {
    throw gpuForbidden(
      FailureCode.PermissionDenied,
      'The server grant does not include GPU access',
    );
  }
  const allowed = new Set(
    grantPciAddresses.flatMap((address) => {
      const canonical = canonicalPciAddress(address);
      return canonical ? [canonical] : [];
    }),
  );
  const denied = addresses.find((address) => !allowed.has(address));
  if (denied) {
    throw gpuForbidden(
      FailureCode.PermissionDenied,
      'The requested GPU is outside the server grant',
      { pciAddress: denied },
    );
  }
}

async function assertUnoccupied(
  ctx: { claims: GpuContext['claims']; containerId?: string },
  addresses: readonly string[],
): Promise<void> {
  if (addresses.length === 0) return;
  const occupied = new Set(await ctx.claims.listOccupied(ctx.containerId));
  const collision = addresses.find((address) => occupied.has(address));
  if (collision) {
    throw gpuConflict(
      FailureCode.GpuDeviceClaimed,
      'A requested GPU is already claimed',
      { pciAddress: collision },
    );
  }
}

function assertRuntimeAvailable(
  ready: boolean | null,
  pciAddresses: readonly string[],
  serverId: string,
): void {
  if (pciAddresses.length > 0 && ready === false) {
    throw gpuConflict(
      FailureCode.GpuRuntimeUnavailable,
      'GPU runtime is not available on the server',
      { serverId },
    );
  }
}

/**
 * Create-time admission. `requestedPciAddresses` is `undefined` when the
 * request omitted `gpuPciAddresses`; the returned state is `null` when the
 * container has no GPU configuration at all.
 */
export async function admitGpuCreate(
  ctx: GpuContext & {
    readonly containerId: string;
    readonly requestedPciAddresses: unknown;
    readonly enabled: boolean;
  },
): Promise<{ readonly state: GpuContainerState | null }> {
  if (!ctx.enabled) {
    if (ctx.requestedPciAddresses === undefined) return { state: null };
    throw gpuConflict(FailureCode.GpuNotEnabled, 'GPU is not enabled on this server');
  }

  const pciAddresses = ctx.requestedPciAddresses === undefined
    ? []
    : parsePciAddressList(ctx.requestedPciAddresses);
  const ready = runtimeReadyFromHealth(await ctx.health.read());
  assertRuntimeAvailable(ready, pciAddresses, ctx.serverId);

  if (pciAddresses.length > 0 && !ctx.actor.admin) {
    assertGpuGrant(ctx.grantPciAddresses, pciAddresses);
  }
  await assertUnoccupied(ctx, pciAddresses);
  await ctx.claims.replace(pciAddresses);

  if (pciAddresses.length > 0) {
    return { state: { nvidiaRuntime: true, pciAddresses } };
  }
  return { state: { nvidiaRuntime: ready === true, pciAddresses: [] } };
}

export async function mutateGpuContainer(
  ctx: GpuContext & {
    readonly containerId: string;
    /** API stop gating is `observedStatus !== 'stopped'` (includes frozen). */
    readonly observedStatus: 'running' | 'stopped' | 'frozen' | 'error' | 'unknown';
    readonly currentState: unknown;
    readonly payload: unknown;
    readonly enabled: boolean;
  },
): Promise<{
  readonly state: GpuContainerState | null;
  readonly requestSummary: Record<string, unknown>;
}> {
  if (!ctx.enabled) {
    throw gpuConflict(FailureCode.GpuNotEnabled, 'GPU is not enabled on this server');
  }

  const pciAddresses = parseMutatePciAddresses(ctx.payload);
  const current = parseContainerState(ctx.currentState);
  if (!current && pciAddresses.length === 0) {
    await ctx.claims.replace([]);
    return {
      state: null,
      requestSummary: { operation: 'devices', pciAddresses: [] },
    };
  }
  const previous = current ?? { nvidiaRuntime: false, pciAddresses: [] satisfies string[] };
  const nextRuntime = pciAddresses.length > 0 ? true : previous.nvidiaRuntime;
  const assignmentChanged = previous.nvidiaRuntime !== nextRuntime
    || !pciListsEqual(previous.pciAddresses, pciAddresses);

  if (assignmentChanged && ctx.observedStatus !== 'stopped') {
    throw gpuConflict(
      FailureCode.GpuMutationRequiresStop,
      'GPU assignment changes require a stopped container',
    );
  }

  const ready = runtimeReadyFromHealth(await ctx.health.read());
  assertRuntimeAvailable(ready, pciAddresses, ctx.serverId);

  if (pciAddresses.length > 0 && !ctx.actor.admin) {
    assertGpuGrant(ctx.grantPciAddresses, pciAddresses);
  }
  await assertUnoccupied(ctx, pciAddresses);
  await ctx.claims.replace(pciAddresses);

  return {
    state: { nvidiaRuntime: nextRuntime, pciAddresses },
    requestSummary: { operation: 'devices', pciAddresses },
  };
}
