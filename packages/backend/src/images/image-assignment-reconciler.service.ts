import { Injectable, OnModuleInit } from '@nestjs/common';
import { AuditService } from '../iam/audit.service.js';
import { NyabaseConfigService } from '../platform/config/nyabase-config.service.js';
import { IncusError, type IncusClientPort } from '../incus/index.js';
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
  deleteManagedImage,
  deletePreviousImageIfUnused,
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

const CLEANUP_RETRY_MS = 5_000;

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

  constructor(
    private readonly store: ImageReconcileStore,
    config: NyabaseConfigService,
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
    await this.scanImageCleanup(serverId);
  }

  /** Queue cleanup of inactive images no server holds; only one server (the lowest id) does it. */
  private async scanImageCleanup(serverId: string): Promise<void> {
    const imageRows = await this.store.listImagesPendingCleanup();
    const assignedImageIds = await this.store.listAssignedImageIds();
    if (await this.store.cleanupOwnerServerId() !== serverId) return;
    for (const image of imageRows) {
      if (assignedImageIds.has(image.id)) continue;
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

  /** Make the desired image present on the server, aliased, and the previous copy retired. */
  private async reconcileEnsure(
    context: ReconcileRunContext,
    client: IncusClientPort,
    assignment: AssignmentRow,
    desired: ImageAssignmentSource,
    actual: Image | undefined,
  ): Promise<ReconcileOutcome> {
    const leftover = await this.store.findLeftoverPinnedContainers(
      assignment.server_id,
      assignment.image_id,
      desired.fingerprint,
    );
    if (leftover) {
      return {
        outcome: 'failed',
        failure: intentFailure(
          'IMAGE_IN_USE',
          'Stop and delete instances still pinned to the previous image fingerprint',
          {
            serverId: assignment.server_id,
            previousFingerprint: leftover,
            desiredFingerprint: desired.fingerprint,
          },
        ),
      };
    }
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
    const previous = assignment.managed_fingerprint;
    const imagesForAlias = (await client.listImages(1)).metadata;
    await ensureAliasOnFingerprint(
      this.audit,
      client,
      imagesForAlias,
      desired.alias,
      fingerprint,
      context.intent,
    );
    const previousInUse = await deletePreviousImageIfUnused(
      this.audit,
      client,
      previous,
      fingerprint,
      context.intent,
    );
    if (previousInUse) {
      return {
        outcome: 'failed',
        failure: intentFailure(
          'IMAGE_IN_USE',
          'Stop and delete instances still using the previous image fingerprint',
          {
            previousFingerprint: previous,
            desiredFingerprint: fingerprint,
          },
        ),
      };
    }
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
    await this.store.bumpCleanupGeneration(assignment.image_id);
    await this.store.markAssignmentDeleted(assignment, true);
    return done();
  }

  /**
   * Remove an inactive image no server holds any more: refuse while assignments
   * or containers remain, delete the physical copy on the cleanup owner, then drop the row.
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
        outcome: 'retry',
        retryAfterMs: CLEANUP_RETRY_MS,
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
        outcome: 'retry',
        retryAfterMs: CLEANUP_RETRY_MS,
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

  /** Delete the server's copy of an inactive image; returns a retry outcome while Incus still uses it. */
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
        outcome: 'retry',
        retryAfterMs: CLEANUP_RETRY_MS,
        failure: intentFailure(
          'IMAGE_CLEANUP_BLOCKED',
          'The inactive image is still used by an Incus resource',
          { fingerprint, usedBy },
        ),
      };
    }
    await deleteManagedImage(this.audit, client, fingerprint, context.intent);
    return null;
  }
}
