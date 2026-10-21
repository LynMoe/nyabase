import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  AuditAction,
  FailureCode,
  IntentKind,
  IntentResourceType,
} from '@nyabase/common';
import type { Transaction } from 'kysely';
import type { AuditService } from '../iam/audit.service.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import type { IntentRecord, IntentRepository } from '../reconcile/intent.repository.js';
import type { VolumeRow } from './volume-dtos.js';
import { createVolumeIntent } from './volume-intents.js';
import type { VolumesRepository } from './volumes.repository.js';

type Tx = Transaction<NyabaseDatabase>;

/** Transaction options for every user-visible volume mutation. */
export const VOLUME_TX = { isolationLevel: 'serializable', maxAttempts: 5 } as const;

export interface VolumeLifecycleDeps {
  readonly repository: VolumesRepository;
  readonly intents: IntentRepository;
  readonly audit: AuditService;
}

export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  const visited = new Set<unknown>();
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const record = current as { code?: unknown; cause?: unknown };
    if (record.code === '23505') return true;
    current = record.cause;
  }
  return false;
}

export function nameTakenConflict(name: string): ConflictException {
  return new ConflictException({
    code: FailureCode.InvalidInput,
    message: 'A volume with this name already exists in the storage scope',
    details: { name },
  });
}

export function assertValidVolumeSize(sizeBytes: number): void {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new BadRequestException({
      code: FailureCode.InvalidInput,
      message: 'Volume size must be a positive safe integer',
    });
  }
}

/** Common preconditions of a PATCH: revision match, not deleting, sane size. */
export function assertPatchable(
  current: VolumeRow,
  input: { expectedRevision: number; sizeBytes?: number },
): void {
  if (current.revision !== input.expectedRevision) {
    throw new ConflictException({ code: FailureCode.RevisionConflict });
  }
  if (current.lifecycle_phase === 'deleting') {
    throw new ConflictException({
      code: FailureCode.InvalidInput,
      message: 'A deleting volume cannot be modified',
      details: { volumeId: current.id, lifecyclePhase: current.lifecycle_phase },
    });
  }
  if (input.sizeBytes !== undefined) assertValidVolumeSize(input.sizeBytes);
}

export async function renameVolume(
  deps: VolumeLifecycleDeps,
  transaction: Tx,
  actorId: string,
  locked: VolumeRow,
  name: string,
): Promise<VolumeRow> {
  const row = await deps.repository.updateDesired(locked.id, locked.revision, { name }, transaction);
  if (!row) throw new ConflictException({ code: FailureCode.RevisionConflict });
  await deps.audit.append(
    transaction,
    actorId,
    AuditAction.UpdateVolume,
    locked.id,
    'volume',
    { name },
  );
  return row;
}

/** Persist the new desired size (and name) and queue one resize intent per placement. */
export async function applyResize(
  deps: VolumeLifecycleDeps,
  transaction: Tx,
  actorId: string,
  locked: VolumeRow,
  input: { name?: string; sizeBytes: number },
  placements: ReadonlyArray<{ server_id: string }>,
): Promise<{ row: VolumeRow; intents: IntentRecord[] }> {
  const row = await deps.repository.updateDesired(
    locked.id,
    locked.revision,
    { ...(input.name === undefined ? {} : { name: input.name }), size_bytes: input.sizeBytes },
    transaction,
  );
  if (!row) throw new ConflictException({ code: FailureCode.RevisionConflict });
  const intents: IntentRecord[] = [];
  for (const placement of placements) {
    intents.push(await createVolumeIntent(deps.intents, {
      kind: IntentKind.VolumeResize,
      resourceType: IntentResourceType.Volume,
      resourceId: locked.id,
      serverId: placement.server_id,
      requestedBy: actorId,
      targetRevision: row.revision,
      request: {
        operation: 'resize',
        idempotencyKey: 'resize',
        sizeBytes: input.sizeBytes,
      },
    }, transaction));
  }
  await deps.audit.append(
    transaction,
    actorId,
    AuditAction.ResizeVolume,
    locked.id,
    'volume',
    { sizeBytes: input.sizeBytes },
  );
  return { row, intents };
}

async function settlePendingVolumeIntents(
  deps: VolumeLifecycleDeps,
  volumeId: string,
  transaction: Tx,
): Promise<void> {
  for (const id of await deps.repository.listPendingIntentIds(volumeId, transaction)) {
    await deps.intents.settleOne(id, { outcome: 'succeeded' }, transaction);
  }
}

/** A volume the host never held: drop the row now and record an already-succeeded destroy. */
export async function destroyUntrackedVolume(
  deps: VolumeLifecycleDeps,
  transaction: Tx,
  actorId: string,
  current: VolumeRow,
  note: 'never_mounted' | 'empty_tracking',
): Promise<{ row: VolumeRow; intent: IntentRecord }> {
  await settlePendingVolumeIntents(deps, current.id, transaction);
  await deps.repository.deleteVolumeRow(current.id, transaction);
  const intent = await createVolumeIntent(deps.intents, {
    kind: IntentKind.VolumeDestroy,
    resourceType: IntentResourceType.Volume,
    resourceId: current.id,
    requestedBy: actorId,
    targetRevision: current.revision,
    request: { operation: 'destroy', idempotencyKey: 'destroy', note },
  }, transaction);
  await deps.intents.settleOne(intent.id, { outcome: 'succeeded' }, transaction);
  await deps.audit.append(
    transaction,
    actorId,
    AuditAction.DeleteVolume,
    current.id,
    'volume',
    { reason: note },
  );
  return { row: current, intent };
}

/** Flip the volume to `deleting` and queue the physical destroy. */
export async function beginVolumeDestroy(
  deps: VolumeLifecycleDeps,
  transaction: Tx,
  actorId: string,
  current: VolumeRow,
): Promise<{ row: VolumeRow; intent: IntentRecord }> {
  const row = await deps.repository.updateDesired(
    current.id,
    current.revision,
    { lifecycle_phase: 'deleting', needs_attention: false, failure_code: null },
    transaction,
  );
  if (!row) throw new ConflictException({ code: FailureCode.RevisionConflict });
  const intent = await createVolumeIntent(deps.intents, {
    kind: IntentKind.VolumeDestroy,
    resourceType: IntentResourceType.Volume,
    resourceId: current.id,
    requestedBy: actorId,
    targetRevision: row.revision,
    request: { operation: 'destroy', idempotencyKey: 'destroy' },
  }, transaction);
  await deps.audit.append(transaction, actorId, AuditAction.DeleteVolume, current.id, 'volume');
  return { row, intent };
}
