import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import {
  AuditAction,
  FailureCode,
  IntentKind,
  IntentResourceType,
  type VolumeAttachmentDto,
} from '@nyabase/common';
import type { Actor } from '../iam/actor.js';
import { AuditService } from '../iam/audit.service.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import {
  DESPITE_ATTENTION_FIELD,
  IntentRepository,
  type IntentRecord,
} from '../reconcile/intent.repository.js';
import { detachRedriveDue } from './detach-redrive.js';
import { VolumeDtoAssembler } from './volume-dtos.js';
import { VOLUME_TX, type VolumeKind } from './volume-rules.js';
import { VolumesRepository } from './volumes.repository.js';

type Tx = Transaction<NyabaseDatabase>;
/**
 * Mounts of volumes in containers: the list a container shows, and the
 * forced unmount of the access-lapse processor. Users neither mount nor
 * unmount: the volume provisioner mounts every volume a user is owed into
 * all of their containers.
 */
@Injectable()
export class VolumeAttachmentsService {
  constructor(
    private readonly repository: VolumesRepository,
    private readonly transactions: PgTransactionManager,
    private readonly intents: IntentRepository,
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly audit: AuditService,
    private readonly dtos: VolumeDtoAssembler,
  ) {}

  /** Attachments of a container the caller has already been authorised to see. */
  async listForContainer(containerId: string, kind: VolumeKind): Promise<VolumeAttachmentDto[]> {
    const container = await this.database.selectFrom('control.containers')
      .select(['id', 'owner_id', 'server_id'])
      .where('id', '=', containerId)
      .executeTakeFirst();
    if (!container) {
      throw new NotFoundException('Container not found');
    }
    return this.dtos.listAttachmentDtos(containerId, container.server_id, kind);
  }

  /**
   * Detaches whatever the container's power state: the owner lost access to
   * the volume's pool or shared backend, or the volume is being destroyed.
   * The reconciler unplugs the disk from a running container live (and
   * deletes the row once the device is gone); the container itself is left
   * alone. Returns null when the attachment or its container is gone, the
   * container is deleting, or the attachment is already detaching and no
   * re-drive is due. A detaching attachment is detached again once
   * `detachRedriveDue` holds: no intent of the container is pending that the
   * worker will run (one that waits on the container's `needs_attention` does
   * not count) and the backoff since its last settled intent has passed.
   * Every intent queued here runs despite the attention
   * (`runsDespiteAttention`); a re-drive keeps `needs_attention`, so a
   * container whose intents keep failing stays visible. Success clears the
   * attention; a failure, or a stale pass superseded by a newer revision,
   * leaves the row detaching. So a caller that keeps calling this (the
   * access-lapse pass) gets a new intent each time the backoff has passed,
   * until the row is gone, whatever the container's other intents do; it
   * cannot force an instance that keeps refusing the unplug.
   */
  async forceDetach(actor: Actor, attachmentId: string): Promise<IntentRecord | null> {
    return this.transactions.run(async (transaction) => {
      const attachment = await this.repository.findAttachmentForUpdate(attachmentId, transaction);
      if (!attachment) return null;
      const container = await transaction.selectFrom('control.containers').selectAll()
        .where('id', '=', attachment.container_id).forUpdate().executeTakeFirst();
      if (!container || container.lifecycle_phase === 'deleting') return null;
      const redrive = attachment.bind_state === 'detaching';
      if (redrive) {
        const { rows } = await sql<{ due: boolean }>`
          SELECT ${detachRedriveDue(sql`${attachment.id}::uuid`, sql`${container.id}::uuid`)} AS due
        `.execute(transaction);
        if (!rows[0]?.due) return null;
      }
      return this.beginDetach(
        transaction,
        actor.userId,
        attachment,
        container,
        redrive ? { reason: 'access_lapse', redrive: true } : { reason: 'access_lapse' },
        { clearAttention: !redrive, despiteAttention: true },
      );
    }, VOLUME_TX);
  }

  /**
   * Marks the attachment detaching, bumps the container revision and queues
   * its update. A re-drive (`clearAttention: false`) keeps `needs_attention`;
   * `despiteAttention` marks the intent so the worker runs it all the same.
   */
  private async beginDetach(
    transaction: Tx,
    actorId: string | null,
    attachment: { id: string; volume_id: string },
    container: { id: string; server_id: string; revision: number },
    auditDetails: Record<string, unknown>,
    options: { readonly clearAttention: boolean; readonly despiteAttention?: boolean } = {
      clearAttention: true,
    },
  ): Promise<IntentRecord> {
    await this.repository.setAttachmentBindState(attachment.id, 'detaching', transaction);
    const revision = Number(container.revision) + 1;
    const updated = await transaction.updateTable('control.containers').set({
      revision,
      ...(options.clearAttention ? { needs_attention: false } : {}),
    })
      .where('id', '=', container.id)
      .where('revision', '=', container.revision)
      .returning('id')
      .executeTakeFirst();
    if (!updated) {
      throw new ConflictException({ code: FailureCode.RevisionConflict });
    }
    const intent = await this.intents.createPending({
      kind: IntentKind.ContainerUpdate,
      resourceType: IntentResourceType.Container,
      resourceId: container.id,
      serverId: container.server_id,
      requestedBy: actorId,
      targetRevision: revision,
      request: {
        operation: 'detach_volume',
        attachmentId: attachment.id,
        ...(options.despiteAttention ? { [DESPITE_ATTENTION_FIELD]: true } : {}),
      },
    }, transaction);
    await this.audit.append(
      transaction,
      actorId,
      AuditAction.DetachVolume,
      attachment.id,
      'volume_attachment',
      { containerId: container.id, volumeId: attachment.volume_id, ...auditDetails },
    );
    return intent;
  }
}
