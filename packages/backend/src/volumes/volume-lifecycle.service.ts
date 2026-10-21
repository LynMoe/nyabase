import { ConflictException, Injectable } from '@nestjs/common';
import { AuditAction, FailureCode, IntentKind, IntentResourceType } from '@nyabase/common';
import type { Transaction } from 'kysely';
import { AuditService } from '../iam/audit.service.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { IntentRepository, type IntentRecord } from '../reconcile/intent.repository.js';
import type { VolumeRow } from './volume-dtos.js';
import { createVolumeIntent, VolumesRepository } from './volumes.repository.js';

type Tx = Transaction<NyabaseDatabase>;

/** Desired-state changes shared by local and shared volumes: rename, resize and destroy. */
@Injectable()
export class VolumeLifecycleService {
  constructor(
    private readonly repository: VolumesRepository,
    private readonly intents: IntentRepository,
    private readonly audit: AuditService,
  ) {}

  async renameVolume(
    transaction: Tx,
    actorId: string,
    locked: VolumeRow,
    name: string,
  ): Promise<VolumeRow> {
    const row = await this.repository.updateDesired(locked.id, locked.revision, { name }, transaction);
    if (!row) throw new ConflictException({ code: FailureCode.RevisionConflict });
    await this.audit.append(
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
  async applyResize(
    transaction: Tx,
    actorId: string,
    locked: VolumeRow,
    input: { name?: string; sizeBytes: number },
    placements: ReadonlyArray<{ server_id: string }>,
  ): Promise<{ row: VolumeRow; intents: IntentRecord[] }> {
    const row = await this.repository.updateDesired(
      locked.id,
      locked.revision,
      { ...(input.name === undefined ? {} : { name: input.name }), size_bytes: input.sizeBytes },
      transaction,
    );
    if (!row) throw new ConflictException({ code: FailureCode.RevisionConflict });
    const intents: IntentRecord[] = [];
    for (const placement of placements) {
      intents.push(await createVolumeIntent(this.intents, {
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
    await this.audit.append(
      transaction,
      actorId,
      AuditAction.ResizeVolume,
      locked.id,
      'volume',
      { sizeBytes: input.sizeBytes },
    );
    return { row, intents };
  }

  private async settlePendingVolumeIntents(
    volumeId: string,
    transaction: Tx,
  ): Promise<void> {
    for (const id of await this.repository.listPendingIntentIds(volumeId, transaction)) {
      await this.intents.settleOne(id, { outcome: 'succeeded' }, transaction);
    }
  }

  /** A volume the host never held: drop the row now and record an already-succeeded destroy. */
  async destroyUntrackedVolume(
    transaction: Tx,
    actorId: string,
    current: VolumeRow,
    note: 'never_mounted' | 'empty_tracking',
  ): Promise<{ row: VolumeRow; intent: IntentRecord }> {
    await this.settlePendingVolumeIntents(current.id, transaction);
    await this.repository.deleteVolumeRow(current.id, transaction);
    const intent = await createVolumeIntent(this.intents, {
      kind: IntentKind.VolumeDestroy,
      resourceType: IntentResourceType.Volume,
      resourceId: current.id,
      requestedBy: actorId,
      targetRevision: current.revision,
      request: { operation: 'destroy', idempotencyKey: 'destroy', note },
    }, transaction);
    await this.intents.settleOne(intent.id, { outcome: 'succeeded' }, transaction);
    await this.audit.append(
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
  async beginVolumeDestroy(
    transaction: Tx,
    actorId: string,
    current: VolumeRow,
  ): Promise<{ row: VolumeRow; intent: IntentRecord }> {
    const row = await this.repository.updateDesired(
      current.id,
      current.revision,
      { lifecycle_phase: 'deleting', needs_attention: false, failure_code: null },
      transaction,
    );
    if (!row) throw new ConflictException({ code: FailureCode.RevisionConflict });
    const intent = await createVolumeIntent(this.intents, {
      kind: IntentKind.VolumeDestroy,
      resourceType: IntentResourceType.Volume,
      resourceId: current.id,
      requestedBy: actorId,
      targetRevision: row.revision,
      request: { operation: 'destroy', idempotencyKey: 'destroy' },
    }, transaction);
    await this.audit.append(transaction, actorId, AuditAction.DeleteVolume, current.id, 'volume');
    return { row, intent };
  }
}
