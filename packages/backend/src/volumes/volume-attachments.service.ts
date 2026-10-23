import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import {
  AuditAction,
  FailureCode,
  IntentKind,
  IntentResourceType,
  type AttachVolumeRequest,
  type IntentAcceptedDto,
  type ListScope,
  type VolumeAttachmentDto,
} from '@nyabase/common';
import type { Actor } from '../iam/actor.js';
import { AuditService } from '../iam/audit.service.js';
import { deterministicName } from '../platform/domain-utils.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { acceptedIntent } from '../reconcile/accepted-intent.js';
import { IntentRepository, type IntentRecord } from '../reconcile/intent.repository.js';
import { StoragePoolsRepository } from '../storage-pools/storage-pools.repository.js';
import { detachRedriveDue } from './detach-redrive.js';
import { VolumeDtoAssembler, type VolumeRow } from './volume-dtos.js';
import {
  VOLUME_TX,
  assertCanAttach,
  isUniqueViolation,
  type VolumeAccess,
  type VolumeKind,
} from './volume-rules.js';
import {
  VolumesRepository,
  assertPoolGrant,
  assertSharedGrant,
  requireServerAccess,
} from './volumes.repository.js';
import { requireUserId } from '../iam/actor.js';

type Tx = Transaction<NyabaseDatabase>;
type ContainerRef = { id: string; owner_id: string; server_id: string };

const ALREADY_ATTACHED = 'The volume is already attached to this container or the path is in use';

/** Attaching and detaching volumes (local and shared) on containers. */
@Injectable()
export class VolumeAttachmentsService {
  constructor(
    private readonly repository: VolumesRepository,
    private readonly pools: StoragePoolsRepository,
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

  async bindCreateTimeVolumes(
    transaction: Tx,
    actor: Actor,
    container: ContainerRef,
    volumes: readonly AttachVolumeRequest[],
  ): Promise<void> {
    for (const input of volumes) {
      await this.bindAttachmentRow(transaction, requireUserId(actor), 'owner', container, input, null);
    }
  }

  async attach(
    actor: Actor,
    containerId: string,
    input: AttachVolumeRequest,
    kind: VolumeKind,
    scope: ListScope = 'mine',
  ): Promise<IntentAcceptedDto> {
    const actorId = requireUserId(actor);
    const result = await this.transactions.run(async (transaction) => {
      const container = await transaction.selectFrom('control.containers').selectAll()
        .where('id', '=', containerId).forUpdate().executeTakeFirst();
      if (!container) throw new NotFoundException('Container not found');
      const access = assertCanAttach(actor, container, scope);
      const revision = Number(container.revision) + 1;
      await transaction.updateTable('control.containers')
        .set({ revision, needs_attention: false })
        .where('id', '=', containerId)
        .where('revision', '=', container.revision)
        .executeTakeFirstOrThrow();
      const attachment = await this.bindAttachmentRow(
        transaction,
        actorId,
        access,
        container,
        input,
        kind,
      );
      const intent = await this.intents.createPending({
        kind: IntentKind.ContainerUpdate,
        resourceType: IntentResourceType.Container,
        resourceId: containerId,
        serverId: container.server_id,
        requestedBy: actorId,
        targetRevision: revision,
        request: { operation: 'attach_volume', volumeId: input.volumeId, attachmentId: attachment.id },
      }, transaction);
      await this.audit.append(
        transaction,
        actorId,
        AuditAction.AttachVolume,
        attachment.id,
        'volume_attachment',
        { containerId, volumeId: input.volumeId },
      );
      return { intent };
    }, VOLUME_TX).catch((error: unknown) => {
      if (isUniqueViolation(error)) {
        throw new ConflictException({
          code: FailureCode.InvalidInput,
          message: ALREADY_ATTACHED,
          details: { containerId, volumeId: input.volumeId, containerPath: input.containerPath },
        });
      }
      throw error;
    });
    return acceptedIntent(result.intent);
  }

  /** The volume the caller may attach: visible to them, of the right kind, usable. */
  private async lockAttachableVolume(
    transaction: Tx,
    actorId: string,
    access: VolumeAccess,
    container: ContainerRef,
    input: AttachVolumeRequest,
    expectedKind: VolumeKind | null,
  ): Promise<VolumeRow> {
    const volume = await this.repository.findByIdForUpdate(input.volumeId, transaction);
    const volumeKind: VolumeKind | null = !volume
      ? null
      : volume.shared_backend_id !== null ? 'shared' : 'local';
    if (
      !volume
      || (access === 'owner' && volume.owner_id !== actorId)
      || (expectedKind !== null && volumeKind !== expectedKind)
    ) {
      throw new NotFoundException('Volume not found');
    }
    if (volume.owner_id !== container.owner_id) {
      throw new ForbiddenException('A volume may only attach to its owner container');
    }
    if (volume.lifecycle_phase === 'deleting' || volume.lifecycle_phase === 'failed') {
      throw new ConflictException({
        code: FailureCode.InvalidInput,
        message: 'A deleting or failed volume cannot be attached',
        details: { volumeId: volume.id, lifecyclePhase: volume.lifecycle_phase },
      });
    }
    return volume;
  }

  /** The pool through which the volume is reachable on the container's server. */
  private async placementPoolFor(
    transaction: Tx,
    volume: VolumeRow,
    container: ContainerRef,
  ): Promise<string> {
    if (volume.server_id !== null && volume.server_id !== container.server_id) {
      throw new ConflictException({
        code: FailureCode.VolumeCrossServerDenied,
        message: 'A local volume can only attach on its pool server',
        details: {
          volumeId: volume.id,
          serverId: container.server_id,
          reason: 'local_pool_server_mismatch',
        },
      });
    }
    let placementPoolId = volume.pool_id;
    if (volume.shared_backend_id !== null) {
      const visible = await this.pools.listRegisteredSharedPools({
        backendIds: [volume.shared_backend_id],
        serverId: container.server_id,
      }, transaction);
      if (visible.length !== 1) throw new ConflictException({
        code: FailureCode.VolumeCrossServerDenied,
        message: 'The shared backend is not registered on the target server',
        details: {
          volumeId: volume.id,
          serverId: container.server_id,
          reason: 'backend_not_reachable',
        },
      });
      placementPoolId = visible[0]!.id;
    }
    if (!placementPoolId) {
      throw new ConflictException({
        code: FailureCode.VolumeCrossServerDenied,
        message: 'A local volume is missing its pool',
      });
    }
    return placementPoolId;
  }

  private async bindAttachmentRow(
    transaction: Tx,
    actorId: string,
    access: VolumeAccess,
    container: ContainerRef,
    input: AttachVolumeRequest,
    expectedKind: VolumeKind | null,
  ): Promise<{ id: string }> {
    const volume = await this.lockAttachableVolume(
      transaction,
      actorId,
      access,
      container,
      input,
      expectedKind,
    );
    if (access === 'owner') {
      // Attaching is denied without current coverage of every resource involved.
      await requireServerAccess(transaction, container.owner_id, container.server_id);
      if (volume.shared_backend_id !== null) {
        await assertSharedGrant(transaction, volume.owner_id, volume.shared_backend_id);
      } else if (volume.pool_id !== null) {
        await assertPoolGrant(transaction, volume.owner_id, volume.pool_id);
      }
    }
    const placementPoolId = await this.placementPoolFor(transaction, volume, container);
    const occupied = await this.repository.findConflictingAttachment(
      container.id,
      volume.id,
      input.containerPath,
      transaction,
    );
    if (occupied) {
      throw new ConflictException({
        code: FailureCode.InvalidInput,
        message: ALREADY_ATTACHED,
        details: {
          containerId: container.id,
          volumeId: volume.id,
          containerPath: input.containerPath,
          attachmentId: occupied.id,
        },
      });
    }
    const attachmentId = randomUUID();
    const attachment = await this.repository.insertAttachment({
      id: attachmentId,
      containerId: container.id,
      volumeId: volume.id,
      deviceName: deterministicName('nyd', attachmentId),
      containerPath: input.containerPath,
      readOnly: input.readOnly,
      bindState: 'attaching',
    }, transaction);
    await this.repository.upsertPlacement({
      volumeId: volume.id,
      serverId: container.server_id,
      poolId: placementPoolId,
      catalogState: 'ensuring',
    }, transaction);
    return attachment;
  }

  async detach(
    actor: Actor,
    attachmentId: string,
    expectedContainerId: string,
    kind: VolumeKind,
    scope: ListScope = 'mine',
  ): Promise<unknown> {
    const actorId = requireUserId(actor);
    const result = await this.transactions.run(async (transaction) => {
      const attachment = await this.repository.findAttachmentForUpdate(attachmentId, transaction);
      if (!attachment || attachment.container_id !== expectedContainerId) {
        throw new NotFoundException('Volume attachment not found');
      }
      const attachmentKind = attachment.shared_backend_id !== null ? 'shared' : 'local';
      if (attachmentKind !== kind) {
        throw new NotFoundException('Volume attachment not found');
      }
      const container = await transaction.selectFrom('control.containers').selectAll()
        .where('id', '=', attachment.container_id).forUpdate().executeTakeFirst();
      if (!container) throw new NotFoundException('Container not found');
      assertCanAttach(actor, container, scope);
      await this.assertDetachableNow(transaction, attachment, container);
      return this.beginDetach(transaction, actorId, attachment, container, {});
    }, VOLUME_TX);
    return acceptedIntent(result);
  }

  /**
   * Detaches whatever the container's power state: the owner lost access to
   * the volume's pool or shared backend. The reconciler unplugs the disk from
   * a running container live; the container itself is left alone. Returns
   * null when the attachment is already going or its container is. A
   * detaching attachment whose container has no pending intent is detached
   * again once the re-drive backoff has passed (`detachRedriveDue`): its
   * intent ended without removing the device (the reconciler deletes the row
   * once the device is gone). A re-drive keeps the container's
   * `needs_attention`, so one whose intents keep failing stays visible.
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
        { clearAttention: !redrive },
      );
    }, VOLUME_TX);
  }

  /**
   * Marks the attachment detaching, bumps the container revision and queues
   * its update. A re-drive (`clearAttention: false`) keeps `needs_attention`.
   */
  private async beginDetach(
    transaction: Tx,
    actorId: string | null,
    attachment: { id: string; volume_id: string },
    container: { id: string; server_id: string; revision: number },
    auditDetails: Record<string, unknown>,
    options: { readonly clearAttention: boolean } = { clearAttention: true },
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
      request: { operation: 'detach_volume', attachmentId: attachment.id },
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

  /** A mounted (or mounting) attachment can only be removed while the container is stopped. */
  private async assertDetachableNow(
    transaction: Tx,
    attachment: { id: string; volume_id: string; bind_state: string },
    container: { id: string; server_id: string; power_intent: string },
  ): Promise<void> {
    const placement = await this.repository.findPlacement(
      attachment.volume_id,
      container.server_id,
      transaction,
    );
    const catalogPresent = placement?.catalog_state === 'present';
    const route = await transaction.selectFrom('control.container_ssh_routes')
      .select('instance_status')
      .where('container_id', '=', container.id)
      .executeTakeFirst();
    const observedStopped = (route?.instance_status ?? '').toLowerCase() === 'stopped';
    const powerStopped = container.power_intent === 'stopped';
    const requiresStop = attachment.bind_state === 'attached'
      || (attachment.bind_state === 'attaching' && catalogPresent);
    if (requiresStop && !(observedStopped && powerStopped)) {
      throw new ConflictException({
        code: FailureCode.VolumeDetachRequiresStop,
        message: '请先停止容器',
        details: { containerId: container.id, attachmentId: attachment.id },
      });
    }
  }
}
