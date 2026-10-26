import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AuditService } from '../iam/audit.service.js';
import { NyabaseConfigService } from '../platform/config/nyabase-config.service.js';
import { IncusError, type IncusClientPort } from '../incus/index.js';
import { AuditAction } from '@nyabase/common';
import { IntentRepository, type IntentFailure, type IntentRecord } from '../reconcile/intent.repository.js';
import { intentFailure } from '../reconcile/intent-model.js';
import type {
  ManagedReconciler,
  ReconcileOutcome,
  ReconcileRunContext,
  ResourceAuthority,
} from '../reconcile/managed-reconciler.js';
import { ReconcilerRegistry } from '../reconcile/reconciler-registry.service.js';
import { ImageReconcileStore, type AssignmentRow } from './image-reconcile.store.js';
import {
  ImagePullNotConfirmedError,
  deleteImageCopy,
  deleteManagedImage,
  ensureAliasOnFingerprint,
  ensurePulled,
  canDeleteManagedImage,
  imageFingerprint,
  imageUsedBy,
  isNotFound,
  sameFingerprint,
  selectImageForAssignment,
  type Image,
  type ImageAssignmentSource,
} from './image-assignment-ops.js';

/**
 * Keeps each server's copy of a catalog image in line with the desired
 * fingerprint: pull, alias, supersede the previous copy, and remove copies
 * nothing needs. The Incus steps live in image-assignment-ops; all SQL is in the store.
 */
@Injectable()
export class ImageAssignmentReconciler implements ManagedReconciler, OnModuleInit {
  readonly resourceType = 'image_assignment' as const;
  private readonly source: ImageAssignmentSource;
  private readonly pulls = new Map<string, Promise<void>>();
  private readonly logger = new Logger(ImageAssignmentReconciler.name);

  constructor(
    private readonly store: ImageReconcileStore,
    private readonly config: NyabaseConfigService,
    private readonly intents: IntentRepository,
    private readonly audit: AuditService,
    private readonly registry: ReconcilerRegistry,
  ) {
    const dedicated = config.get<string>('incus.imageSourceServer');
    this.source = {
      alias: '',
      fingerprint: null,
      sourceServer: dedicated || config.get<string>('incus.preflightSourceServer'),
    };
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  supports(intent: IntentRecord): boolean {
    return intent.resourceType === this.resourceType;
  }

  needsAttention(assignmentId: string): Promise<boolean> {
    return this.store.needsAttention(assignmentId);
  }

  markSucceeded(assignmentId: string): Promise<void> {
    return this.store.markSucceeded(assignmentId);
  }

  markFailure(assignmentId: string, failure: IntentFailure, attention: boolean): Promise<void> {
    return this.store.markFailure(assignmentId, failure, attention);
  }

  async resourceAuthorities(
    assignmentIds: readonly string[],
  ): Promise<Map<string, ResourceAuthority>> {
    return new Map(assignmentIds.map((id) => [id, {
      ownerId: null,
    }]));
  }

  async scan(
    serverId: string,
    client?: IncusClientPort,
    signal?: AbortSignal,
  ): Promise<void> {
    const rows = await this.store.listScanAssignments(serverId);
    let images: readonly Image[] | undefined;
    if (client) {
      images = (await client.listImages(1, { signal })).metadata;
    }
    for (const row of rows) {
      const desired = this.desiredSource(row);
      const observed = row.lifecycle_phase === 'deleting'
        ? images?.find((image) => sameFingerprint(
          imageFingerprint(image),
          row.managed_fingerprint,
        ))
        : selectImageForAssignment(images ?? [], desired);
      const idempotencyKey = images
        ? [
          'image-scan',
          row.lifecycle_phase,
          row.revision,
          desired.fingerprint ?? desired.alias,
          imageFingerprint(observed) ?? 'missing',
        ].join(':')
        : undefined;
      await this.intents.ensurePending({
        kind: row.lifecycle_phase === 'deleting'
          ? 'image_assignment.delete'
          : 'image_assignment.ensure',
        resourceType: 'image_assignment',
        resourceId: row.id,
        serverId,
        targetRevision: row.revision,
        reuseFailed: true,
        request: {
          source: 'full_scan',
          ...(idempotencyKey ? { idempotencyKey } : {}),
        },
      });
    }
    if (client && images) await this.removeUnneededCopies(serverId, client, images, signal);
    await this.scanImageCleanup(serverId, images);
  }

  /**
   * Remove the image copies nyabase recorded on this server that nothing there
   * needs any more: versions an operator deleted, kept versions of an image no
   * longer assigned here once no container on the server uses them, and copies
   * of deleted images. Driven by each full scan from the database state, so a
   * server that is offline or busy catches up later. The preflight probe's
   * pinned image stays.
   */
  private async removeUnneededCopies(
    serverId: string,
    client: IncusClientPort,
    images: readonly Image[],
    signal?: AbortSignal,
  ): Promise<void> {
    const present = images.map((image) => imageFingerprint(image)).filter((value): value is string => !!value);
    await this.store.forgetMissingCopies(serverId, present);
    const unused = images
      .filter((image) => imageUsedBy(image).length === 0)
      .map((image) => imageFingerprint(image))
      .filter((value): value is string => !!value);
    const preflight = this.config.get<string>('incus.preflightImageFingerprint')?.trim().toLowerCase();
    const keep = preflight ? [preflight] : [];
    for (const fingerprint of await this.store.listUnneededCopies(serverId, unused, keep)) {
      if (signal?.aborted) return;
      try {
        const removed = await this.store.removeCopyIfUnneeded(serverId, fingerprint, () => deleteImageCopy(client, fingerprint));
        if (!removed) continue;
        await this.audit.log(null, AuditAction.IncusMutate, removed.imageId ?? serverId, removed.imageId ? 'image' : 'server', {
          method: 'DELETE',
          path: `/1.0/images/${fingerprint}`,
          instanceName: fingerprint,
          serverId,
          reason: 'image_copy_unneeded',
        });
        this.logger.log(`Removed image copy ${fingerprint} from server ${serverId}: nothing there needs it`);
      } catch (error) {
        this.logger.warn(`Removing image copy ${fingerprint} from server ${serverId} failed: ${String(error)}`);
        // The rest would fail the same way; the next scan retries.
        if (error instanceof IncusError && error.code === 'SERVER_UNREACHABLE') return;
      }
    }
  }

  /**
   * Queue cleanup of inactive images nothing holds any more; only one server
   * (the lowest id) does it, from the image list this scan already read.
   * An image still held (an assignment, a container row, an Incus resource
   * using the owner's copy) is not queued: the blocker goes away on its own
   * schedule, so the next full scan looks again instead of an intent polling
   * the database and the agent tunnel meanwhile.
   */
  private async scanImageCleanup(serverId: string, images: readonly Image[] | undefined): Promise<void> {
    if (await this.store.cleanupOwnerServerId() !== serverId) return;
    const imageRows = await this.store.listImagesPendingCleanup();
    if (imageRows.length === 0) return;
    const held = await this.store.listHeldImageIds();
    for (const image of imageRows) {
      if (held.has(image.id)) continue;
      const physical = image.fingerprint
        ? images?.find((candidate) => sameFingerprint(imageFingerprint(candidate), image.fingerprint))
        : undefined;
      if (physical && imageUsedBy(physical).length > 0) continue;
      const revision = Math.max(1, image.cleanup_generation);
      await this.intents.ensurePending({
        kind: 'image_assignment.delete',
        resourceType: 'image_assignment',
        resourceId: image.id,
        serverId,
        targetRevision: revision,
        request: {
          operation: 'cleanup_image',
          imageId: image.id,
          source: 'full_scan',
          idempotencyKey: `image-cleanup:${revision}`,
        },
      });
    }
  }

  async reconcile(context: ReconcileRunContext): Promise<ReconcileOutcome> {
    if (!context.client) {
      throw new IncusError('SERVER_UNREACHABLE', 'retry', { reason: 'missing_client' });
    }
    const assignment = await this.store.readAssignment(context.intent.resourceId);
    if (!assignment) {
      if (context.intent.kind === 'image_assignment.delete') {
        return this.reconcileImageCleanup(context);
      }
      return {
        outcome: 'failed',
        failure: intentFailure(
          'IMAGE_ASSIGNMENT_NOT_FOUND',
          'The image assignment no longer exists',
        ),
      };
    }
    if (context.intent.serverId && context.intent.serverId !== assignment.server_id) {
      return {
        outcome: 'failed',
        failure: intentFailure(
          'IMAGE_ASSIGNMENT_SERVER_MISMATCH',
          'The image assignment intent targets another server',
        ),
      };
    }
    const images = (await context.client.listImages(1)).metadata;
    const desired = this.desiredSource(assignment);
    const actual = selectImageForAssignment(images, desired);
    if (assignment.lifecycle_phase === 'deleting' || context.intent.kind === 'image_assignment.delete') {
      const managedImage = assignment.managed_fingerprint
        ? images.find((image) => sameFingerprint(
          imageFingerprint(image),
          assignment.managed_fingerprint,
        ))
        : undefined;
      return this.reconcileDeletion(
        context.client,
        assignment,
        images,
        assignment.managed_fingerprint ? managedImage : actual,
        context.intent,
      );
    }
    return this.reconcileEnsure(context, context.client, assignment, desired, actual);
  }

  /** Make the desired image present on the server and aliased; earlier versions stay. */
  private async reconcileEnsure(
    context: ReconcileRunContext,
    client: IncusClientPort,
    assignment: AssignmentRow,
    desired: ImageAssignmentSource,
    actual: Image | undefined,
  ): Promise<ReconcileOutcome> {
    const resolved = actual ?? await this.pullAndResolve(context, client, assignment, desired);
    if ('outcome' in resolved) return resolved;
    const fingerprint = imageFingerprint(resolved);
    if (!fingerprint) {
      return {
        outcome: 'failed',
        failure: intentFailure('IMAGE_FINGERPRINT_MISSING', 'Incus returned an image without a fingerprint'),
      };
    }
    if (
      desired.fingerprint !== null
      && desired.fingerprint !== undefined
      && !sameFingerprint(fingerprint, desired.fingerprint)
    ) {
      return {
        outcome: 'failed',
        failure: intentFailure(
          'IMAGE_ASSIGNMENT_FINGERPRINT_MISMATCH',
          'The server image does not match the desired fingerprint',
          { desiredFingerprint: desired.fingerprint, observedFingerprint: fingerprint },
        ),
      };
    }
    const imagesForAlias = (await client.listImages(1)).metadata;
    await ensureAliasOnFingerprint(
      this.audit,
      client,
      imagesForAlias,
      desired.alias,
      fingerprint,
      context.intent,
    );
    // The previous copy stays: containers created from it keep that version, and an
    // operator deletes the version (and its copies) once nothing uses it.
    await this.store.recordEnsured(assignment, fingerprint);
    return { outcome: 'succeeded', observedRevision: assignment.revision };
  }

  /** The image is not on the server yet: pull it, or report why it cannot be had. */
  private async pullAndResolve(
    context: ReconcileRunContext,
    client: IncusClientPort,
    assignment: AssignmentRow,
    desired: ImageAssignmentSource,
  ): Promise<Image | ReconcileOutcome> {
    try {
      await ensurePulled(this.audit, this.pulls, client, desired, assignment.server_id, context.intent);
    } catch (error) {
      if (isNotFound(error)) {
        return {
          outcome: 'failed',
          failure: intentFailure(
            'IMAGE_NOT_AVAILABLE',
            `The image alias ${desired.alias} is not available from the image server`,
          ),
        };
      }
      if (error instanceof ImagePullNotConfirmedError) {
        return {
          outcome: 'failed',
          failure: intentFailure(error.code, error.message, error.details),
        };
      }
      throw error;
    }
    const refreshed = (await client.listImages(1)).metadata;
    const resolved = selectImageForAssignment(refreshed, desired);
    if (resolved) return resolved;
    return {
      outcome: 'failed',
      failure: desired.fingerprint !== null && desired.fingerprint !== undefined
        ? intentFailure(
          'IMAGE_ASSIGNMENT_FINGERPRINT_MISMATCH',
          'The server image did not match the pinned fingerprint after the pull',
          { desiredFingerprint: desired.fingerprint },
        )
        : intentFailure(
          'IMAGE_NOT_AVAILABLE',
          `The image alias ${desired.alias} was not present after the pull`,
        ),
    };
  }

  private desiredSource(assignment: AssignmentRow): ImageAssignmentSource {
    return {
      alias: assignment.alias || this.source.alias,
      fingerprint: assignment.desired_fingerprint ?? this.source.fingerprint,
      sourceServer: this.source.sourceServer,
      imageType: this.source.imageType,
    };
  }

  /**
   * Remove an assignment: delete the managed image from the server unless
   * something else still holds or uses it, then drop the assignment row.
   */
  private async reconcileDeletion(
    client: IncusClientPort,
    assignment: AssignmentRow,
    images: readonly Image[],
    selected: Image | undefined,
    intent: IntentRecord,
  ): Promise<ReconcileOutcome> {
    const done = (): ReconcileOutcome => ({
      outcome: 'succeeded',
      observedRevision: assignment.revision,
    });
    const managed = assignment.managed_fingerprint;
    if (!managed) {
      await this.store.markAssignmentDeleted(assignment, !selected);
      return done();
    }
    if (selected && !sameFingerprint(imageFingerprint(selected), managed)) {
      const managedImage = images.find((candidate) => sameFingerprint(
        imageFingerprint(candidate),
        managed,
      ));
      if (!managedImage) {
        await this.store.markAssignmentDeleted(assignment, true);
        return done();
      }
      if (imageUsedBy(managedImage).length > 0) {
        return {
          outcome: 'failed',
          failure: intentFailure(
            'IMAGE_IN_USE',
            'Stop and delete instances still using the managed image fingerprint',
            { managedFingerprint: managed, observedFingerprint: imageFingerprint(selected) },
          ),
        };
      }
    }
    const image = images.find((candidate) => sameFingerprint(imageFingerprint(candidate), managed));
    if (!image) {
      await this.store.markAssignmentDeleted(assignment, true);
      return done();
    }
    const otherAssignment = await this.store.findOtherAssignmentHolding(assignment, managed);
    const pinned = await this.store.findContainerPinnedTo(assignment.server_id, managed);
    if (!canDeleteManagedImage({
      managedFingerprint: managed,
      actualFingerprint: imageFingerprint(image),
      otherAssignment: Boolean(otherAssignment),
      pinned: Boolean(pinned),
      usedBy: imageUsedBy(image).length > 0,
    })) {
      await this.store.markAssignmentDeleted(assignment, false);
      return done();
    }
    await deleteManagedImage(this.audit, client, managed, intent);
    await this.store.forgetCopy(assignment.server_id, managed);
    await this.store.bumpCleanupGeneration(assignment.image_id);
    await this.store.markAssignmentDeleted(assignment, true);
    return done();
  }

  /**
   * Remove an inactive image no server holds any more: delete the physical
   * copy on the cleanup owner, then drop the row. The scan queues it only once
   * nothing holds the image; one that is held again by the time it runs fails
   * (no polling retry) and the next full scan queues a new one when it is free.
   */
  private async reconcileImageCleanup(
    context: ReconcileRunContext,
  ): Promise<ReconcileOutcome> {
    const image = await this.store.readImage(context.intent.resourceId);
    if (!image) {
      return {
        outcome: 'succeeded',
        observedRevision: context.intent.targetRevision,
      };
    }
    if (
      context.intent.request?.operation !== 'cleanup_image'
      || image.is_active
      || !image.deleting
    ) {
      return {
        outcome: 'failed',
        failure: intentFailure(
          'IMAGE_ASSIGNMENT_NOT_FOUND',
          'The image assignment no longer exists',
        ),
      };
    }
    const assignments = await this.store.listAssignmentIdsOfImage(image.id);
    if (assignments.length > 0) {
      return {
        outcome: 'failed',
        failure: intentFailure(
          'IMAGE_CLEANUP_ASSIGNMENTS_PRESENT',
          'The image still has server assignments to clean up',
          { assignmentCount: assignments.length },
        ),
      };
    }
    const retainedContainer = await this.store.findContainerOfImage(image.id);
    if (retainedContainer) {
      return {
        outcome: 'failed',
        failure: intentFailure(
          'IMAGE_CLEANUP_CONTAINER_PRESENT',
          'The inactive image is still referenced by a container',
          { containerId: retainedContainer.id },
        ),
      };
    }
    if (!context.client) {
      throw new IncusError('SERVER_UNREACHABLE', 'retry', { reason: 'missing_client' });
    }
    if (image.fingerprint) {
      const blocked = await this.deletePhysicalCopy(context, context.client, image.fingerprint);
      if (blocked) return blocked;
    }
    await this.store.deleteInactiveImage(image.id);
    return {
      outcome: 'succeeded',
      observedRevision: context.intent.targetRevision,
    };
  }

  /** Delete the server's copy of an inactive image; returns a failed outcome while Incus still uses it. */
  private async deletePhysicalCopy(
    context: ReconcileRunContext,
    client: IncusClientPort,
    fingerprint: string,
  ): Promise<ReconcileOutcome | null> {
    const images = (await client.listImages(1, { signal: context.signal })).metadata;
    const physical = images.find((candidate) =>
      sameFingerprint(imageFingerprint(candidate), fingerprint));
    if (!physical) return null;
    const usedBy = imageUsedBy(physical);
    if (usedBy.length > 0) {
      return {
        outcome: 'failed',
        failure: intentFailure(
          'IMAGE_CLEANUP_BLOCKED',
          'The inactive image is still used by an Incus resource',
          { fingerprint, usedBy },
        ),
      };
    }
    await deleteManagedImage(this.audit, client, fingerprint, context.intent);
    if (context.intent.serverId) await this.store.forgetCopy(context.intent.serverId, fingerprint);
    return null;
  }
}
