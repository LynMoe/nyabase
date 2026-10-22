import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
} from '@nestjs/common';
import {
  FailureCode,
  MAX_GPU_DEVICES,
  canonicalPciAddress,
  isWildcardPciAddress,
  parseContainerState,
  zPatchContainerGpusRequest,
  type GpuContainerState,
} from '@nyabase/common';
import { isRecord } from '../platform/domain-utils.js';

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

type Details = Record<string, unknown>;

function body(code: string, message: string, details?: Details) {
  return details ? { code, message, details } : { code, message };
}

export function gpuBadRequest(code: string, message: string, details?: Details): BadRequestException {
  return new BadRequestException(body(code, message, details));
}

export function gpuForbidden(code: string, message: string, details?: Details): ForbiddenException {
  return new ForbiddenException(body(code, message, details));
}

export function gpuConflict(code: string, message: string, details?: Details): ConflictException {
  return new ConflictException(body(code, message, details));
}

/** `{ code, message, details }` body of a Nest HTTP exception, for assertions and logging. */
export function gpuErrorBody(error: unknown): { code?: string; message?: string; details?: Details } | null {
  if (!(error instanceof HttpException)) return null;
  const response = error.getResponse();
  return typeof response === 'object' && response !== null ? response as never : null;
}

/**
 * Validate a client-supplied PCI list and return canonical, unique addresses.
 * Throws 400 with a GPU_* code that tells the caller what was wrong.
 */
export function parsePciAddressList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw gpuBadRequest(FailureCode.GpuInvalidPci, 'GPU PCI addresses are invalid');
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      throw gpuBadRequest(FailureCode.GpuInvalidPci, 'GPU PCI address is invalid');
    }
    if (isWildcardPciAddress(item)) {
      throw gpuBadRequest(
        FailureCode.GpuWildcardForbidden,
        'Wildcard PCI selectors are forbidden',
        { pciAddress: item },
      );
    }
    const canonical = canonicalPciAddress(item);
    if (!canonical) {
      throw gpuBadRequest(FailureCode.GpuInvalidPci, 'GPU PCI address is invalid', { pciAddress: item });
    }
    if (seen.has(canonical)) {
      throw gpuBadRequest(
        FailureCode.GpuDuplicatePci,
        'GPU PCI addresses must be unique',
        { pciAddress: canonical },
      );
    }
    seen.add(canonical);
    result.push(canonical);
  }
  if (result.length > MAX_GPU_DEVICES) {
    throw gpuBadRequest(FailureCode.GpuInvalidPci, 'Too many GPU PCI addresses');
  }
  return result;
}

/** Parse the body of `PATCH /containers/:id/gpus`. */
export function parseMutatePciAddresses(body: unknown): string[] {
  const parsed = zPatchContainerGpusRequest.safeParse(body);
  if (parsed.success) return parsed.data.pciAddresses;
  if (isRecord(body) && 'pciAddresses' in body) {
    parsePciAddressList(body.pciAddresses);
  }
  throw gpuBadRequest(FailureCode.InvalidInput, 'GPU request body is invalid');
}

export function gpuOccupiedError() {
  return gpuConflict(FailureCode.GpuOccupied, 'The server still has GPU claims');
}

/** GPU cannot be switched off while any container holds a card. */
export async function assertGpuCanDisable(claims: Pick<GpuClaimsPort, 'count'>): Promise<void> {
  if (await claims.count() > 0) throw gpuOccupiedError();
}

/** Postgres raises P0001 with this HINT when the disable trigger fires. */
export function isGpuOccupiedSqlError(error: unknown): boolean {
  let current: unknown = error;
  const visited = new Set<unknown>();
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const record = current as { code?: unknown; hint?: unknown; cause?: unknown };
    if (record.code === 'P0001' && String(record.hint ?? '') === FailureCode.GpuOccupied) {
      return true;
    }
    current = record.cause;
  }
  return false;
}

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

/** Start-time check: every claim the container holds must still be granted. */
export function assertClaimsGranted(
  grantPciAddresses: readonly string[],
  claimed: readonly string[],
): void {
  const allowed = new Set(
    grantPciAddresses.flatMap((address) => {
      const canonical = canonicalPciAddress(address);
      return canonical ? [canonical] : [];
    }),
  );
  const ungranted = claimed.filter((address) => !allowed.has(address));
  if (ungranted.length === 0) return;
  throw gpuForbidden(
    FailureCode.GpuNotGranted,
    'The container holds GPUs that are no longer in the server grant',
    { pciAddresses: ungranted },
  );
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
