import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  ContainerPhase,
  ContainerPowerIntent,
  ContainerStatus,
  FailureCode,
  IntentKind,
  StoragePoolResizeFamily,
  type ActionAvailability,
  type ContainerAction,
  type CreateContainerRequest,
  type ListScope,
  Role,
} from '@nyabase/common';
import { assertListScope, isSystemActor, type Actor } from '../iam/actor.js';
import type {
  CreatePendingIntentInput,
  IntentExecutor,
  IntentRecord,
  IntentRepository,
  PhysicalSettlement,
} from '../reconcile/intent.repository.js';
import { nullableNumber, numberValue } from '../platform/domain-utils.js';
import { shrinkReservation, type ShrinkReservation } from '../volumes/volume-rules.js';

/** `shrinkReservation` for a container's root disk (`root_shrink_reserved_bytes`). */
export function rootShrinkReservation(
  row: {
    readonly root_size_bytes: string | number;
    readonly root_shrink_reserved_bytes: string | number | null;
  },
  requestedBytes: number,
): ShrinkReservation {
  return shrinkReservation({
    currentBytes: numberValue(row.root_size_bytes),
    reservedBytes: nullableNumber(row.root_shrink_reserved_bytes),
    requestedBytes,
  });
}

export interface RootResizeCheckInput {
  readonly containerId: string;
  readonly requestedBytes: number;
  readonly currentBytes: number;
  readonly usedBytes: number | null;
  readonly resizeFamily: string;
  readonly observedStatus: ContainerStatus;
}

/**
 * Quota-online roots with no observed usage (including Incus reporting 0)
 * cannot shrink. A booted image is never an empty filesystem.
 */
export function checkRootResize(
  input: RootResizeCheckInput,
): { code: FailureCode; message: string; details: Record<string, unknown> } | null {
  if (input.requestedBytes >= input.currentBytes) return null;
  if (input.resizeFamily === StoragePoolResizeFamily.BlockBacked
    && input.observedStatus !== ContainerStatus.Stopped) {
    return {
      code: FailureCode.RootShrinkRequiresStop,
      message: 'Block-backed root shrink requires a stopped container',
      details: { containerId: input.containerId },
    };
  }
  if (input.resizeFamily === StoragePoolResizeFamily.QuotaOnline) {
    if (input.usedBytes === null || input.usedBytes <= 0) {
      return {
        code: FailureCode.RootUsageUnknown,
        message: 'Root disk usage is unknown; shrink is not allowed until usage is observed',
        details: {
          containerId: input.containerId,
          requestedBytes: input.requestedBytes,
          usedBytes: input.usedBytes,
        },
      };
    }
  }
  if (input.usedBytes !== null && input.usedBytes > input.requestedBytes) {
    return {
      code: FailureCode.RootShrinkBelowUsage,
      message: 'The requested root disk size is below current usage',
      details: {
        containerId: input.containerId,
        requestedBytes: input.requestedBytes,
        usedBytes: input.usedBytes,
      },
    };
  }
  return null;
}

export function containerStatus(
  value: string | null | undefined,
  power: ContainerPowerIntent,
): ContainerStatus {
  const normalized = value?.toLowerCase();
  if (normalized === 'running') return ContainerStatus.Running;
  if (normalized === 'stopped') return ContainerStatus.Stopped;
  if (normalized === 'frozen') return ContainerStatus.Frozen;
  if (normalized === 'error') return ContainerStatus.Error;
  if (value !== null && value !== undefined) return ContainerStatus.Unknown;
  if (power === ContainerPowerIntent.Stopped) return ContainerStatus.Stopped;
  return ContainerStatus.Unknown;
}

export function assertContainerName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/.test(name)) {
    throw new BadRequestException({
      code: FailureCode.InvalidInput,
      message: 'Container name must be 1-63 characters and use letters, numbers, or hyphen',
    });
  }
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  let current: unknown = error;
  const visited = new Set<unknown>();
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const record = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (record.code === '23505') {
      if (!constraint) return true;
      return String(record.constraint ?? '').includes(constraint);
    }
    current = record.cause;
  }
  return false;
}

export function gpuDeviceClaimed(pciAddress?: string): ConflictException {
  return new ConflictException({
    code: FailureCode.GpuDeviceClaimed,
    message: 'A requested GPU is already claimed',
    details: pciAddress ? { pciAddress } : {},
  });
}

export function assertCreateNumbers(request: CreateContainerRequest): void {
  if (!Number.isSafeInteger(request.rootSizeBytes) || request.rootSizeBytes <= 0
    || !Number.isSafeInteger(request.memBytes) || request.memBytes <= 0) {
    throw new BadRequestException({
      code: FailureCode.InvalidInput,
      message: 'Container memory and root size must be positive safe integers',
    });
  }
}

export function stringArray(value: string[] | string | null | undefined): string[] {
  if (Array.isArray(value)) return [...value];
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Memory is granted per server and every container whose desired intent is
 * running counts against it, failed ones included (an intent retry can bring
 * them back); only deleting ones do not. Callers check it on transitions that increase
 * running memory (start, running create, running limit increase), under the
 * owner/server quota lock. CPU needs no check here; all of the user's
 * containers share the user's pinned CPU set.
 */
export function assertMemoryGrant(
  grant: { memBytes: number | null },
  requestedMemBytes: number,
  otherContainersMemBytes: number,
): void {
  if (grant.memBytes === null) return;
  if (otherContainersMemBytes + requestedMemBytes > grant.memBytes) {
    throw new ForbiddenException({
      code: FailureCode.MemoryGrantExceeded,
      message: 'Running memory would exceed the server grant',
      details: {
        requestedMemBytes,
        runningMemBytes: otherContainersMemBytes,
        grantMemBytes: grant.memBytes,
        availableMemBytes: Math.max(0, grant.memBytes - otherContainersMemBytes),
      },
    });
  }
}

// --- authorisation ------------------------------------------------------------

export type ContainerAccess = 'owner' | 'admin' | 'system';

/**
 * The one container authorisation rule: the owner gets the owner rules (live
 * server grant and its limits) whatever their role; `scope=all` (operator
 * role required, else 403) is the explicit override that gets the
 * administrator rules (no server-grant limits), also on the operator's own
 * containers; the system always passes. Anyone else's container is a 404.
 */
export function assertCanAccess(
  actor: Actor,
  row: { owner_id: string },
  scope: ListScope,
): ContainerAccess {
  assertListScope(actor, scope, Role.Operator);
  if (isSystemActor(actor)) return 'system';
  if (scope === 'all') return 'admin';
  if (row.owner_id === actor.userId) return 'owner';
  throw new NotFoundException('Container not found');
}


// --- root shrink (reconciler guard) -------------------------------------------

export type RootShrinkBlock = 'usage_unknown' | 'usage_floor' | 'requires_stop';

export function decideRootShrink(input: {
  readonly resizeFamily: 'quota_online' | 'block_backed';
  readonly actualRootBytes: bigint;
  readonly desiredRootBytes: bigint;
  readonly usedBytes: bigint | null;
  readonly running: boolean;
}): 'allow' | RootShrinkBlock {
  if (input.desiredRootBytes >= input.actualRootBytes) return 'allow';
  if (input.resizeFamily === 'block_backed' && input.running) return 'requires_stop';
  if (input.resizeFamily === 'quota_online' && (input.usedBytes === null || input.usedBytes <= 0n)) {
    return 'usage_unknown';
  }
  if (input.usedBytes !== null && input.desiredRootBytes < input.usedBytes) return 'usage_floor';
  return 'allow';
}


// --- intents ------------------------------------------------------------------

export function isRestartIntent(
  kind: string,
  request: Record<string, unknown> | null | undefined,
): boolean {
  return kind === IntentKind.ContainerPower && request?.action === 'restart';
}

/**
 * A restart is proven by the instance start time moving past the baseline
 * recorded at request time, so a restart must carry exactly that baseline and
 * no other container intent may carry one.
 */
export function assertContainerIntentBaseline(
  input: Pick<CreatePendingIntentInput, 'kind' | 'request' | 'baseline'>,
): void {
  if (!isRestartIntent(input.kind, input.request)) {
    if (input.baseline) throw new Error('Only restart intents may carry a baseline');
    return;
  }
  const baseline = input.baseline;
  if (
    !baseline
    || Object.keys(baseline).some((key) => key !== 'startedAt')
    || !Object.prototype.hasOwnProperty.call(baseline, 'startedAt')
    || (baseline.startedAt !== null && typeof baseline.startedAt !== 'string')
  ) {
    throw new Error('Restart intents require a startedAt baseline');
  }
}

export async function createContainerIntent(
  intents: Pick<IntentRepository, 'createPending'>,
  input: CreatePendingIntentInput,
  executor?: IntentExecutor,
): Promise<IntentRecord> {
  assertContainerIntentBaseline(input);
  return intents.createPending(input, executor);
}

/**
 * Settles a finished container intent. A restart settles only itself (and its
 * success settles the older desired-state intents it covers); a later
 * desired-state revision that succeeds must never settle a pending restart,
 * because only the restart's own start-time proof can.
 */
export async function settleContainerIntent(
  intents: Pick<IntentRepository, 'settleOne' | 'settleForObservedRevision'>,
  intent: IntentRecord,
  observedRevision: number,
  settlement: PhysicalSettlement,
): Promise<void> {
  if (isRestartIntent(intent.kind, intent.request)) {
    await intents.settleOne(intent.id, settlement);
    if (settlement.outcome !== 'succeeded') return;
  }
  await intents.settleForObservedRevision(
    intent.resourceType,
    intent.resourceId,
    observedRevision,
    settlement,
    undefined,
    { keep: (candidate) => isRestartIntent(candidate.kind, candidate.request) },
  );
}

// --- action availability --------------------------------------------------------

export interface ContainerActionPolicyInput {
  phase: ContainerPhase;
  runtimeStatus: ContainerStatus | null;
  runtimeReady: boolean;
  intentPending: boolean;
  sshEnabled: boolean;
}

const DISABLED_ACTIONS: readonly ContainerAction[] = [
  'start',
  'stop',
  'restart',
  'delete',
  'stats',
  'console',
];

function actionDisabled(
  reason: ActionAvailability['reason'],
  message: string,
): ActionAvailability {
  return { enabled: false, reason, message };
}

function allActionsDisabled(
  reason: ActionAvailability['reason'],
  message: string,
): Record<ContainerAction, ActionAvailability> {
  return Object.fromEntries(
    DISABLED_ACTIONS.map((action) => [action, actionDisabled(reason, message)]),
  ) as Record<ContainerAction, ActionAvailability>;
}

/** Which of the container's actions the UI may offer, from its phase and observed runtime. */
export function containerActionAvailability(
  input: ContainerActionPolicyInput,
): Record<ContainerAction, ActionAvailability> {
  const enabled: ActionAvailability = { enabled: true };
  if (input.intentPending) {
    return {
      ...allActionsDisabled('intent_pending', 'Another durable intent is pending'),
      delete: enabled,
    };
  }
  if (!input.runtimeReady) {
    return allActionsDisabled('server_unreachable', 'Server runtime is not ready');
  }
  if (input.phase === ContainerPhase.Deleting) {
    return allActionsDisabled('phase_not_active', 'Container is being deleted');
  }
  if (input.phase === ContainerPhase.Provisioning) {
    return allActionsDisabled('phase_not_active', 'Container is not active yet');
  }
  if (input.phase === ContainerPhase.Failed) {
    return {
      ...allActionsDisabled('phase_not_active', 'Container is failed'),
      delete: enabled,
    };
  }
  const running = input.runtimeStatus === ContainerStatus.Running;
  const stopped = input.runtimeStatus === ContainerStatus.Stopped;
  return {
    start: stopped ? enabled : actionDisabled('phase_not_active', 'Container is not stopped'),
    stop: running ? enabled : actionDisabled('phase_not_active', 'Container is not running'),
    restart: running ? enabled : actionDisabled('phase_not_active', 'Container is not running'),
    delete: enabled,
    stats: running ? enabled : actionDisabled('phase_not_active', 'Container is not running'),
    console: running && input.sshEnabled
      ? enabled
      : actionDisabled('phase_not_active', 'Container console is not ready'),
  };
}
