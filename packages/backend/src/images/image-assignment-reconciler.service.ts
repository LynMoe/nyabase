import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { Capability } from '@nyabase/common';
import type { Kysely } from 'kysely';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { AuditService } from '../iam/audit.service.js';
import { NyabaseConfigService } from '../platform/config/nyabase-config.service.js';
import { IncusError, type IncusClientPort } from '../incus/index.js';
import { IntentRepository, type IntentFailure, type IntentRecord } from '../reconcile/intent.repository.js';
import type {
  ManagedReconciler,
  ReconcileOutcome,
  ReconcileRunContext,
  ResourceAuthority,
} from '../reconcile/managed-reconciler.js';
import { ReconcilerRegistry } from '../reconcile/reconciler-registry.service.js';
import { reconcileDeletion, reconcileImageCleanup } from './image-assignment-deletion.js';
import {
  deletePreviousImageIfUnused,
  ensureAliasOnFingerprint,
  ensurePulled,
} from './image-physical.js';
import type { ImageReconcileDeps } from './image-reconcile-deps.js';
import { ImageReconcileStore } from './image-reconcile.store.js';
import {
  ImagePullNotConfirmedError,
  imageFailure,
  imageFingerprint,
  isNotFound,
  sameFingerprint,
  selectImageForAssignment,
  type AssignmentRow,
  type Image,
  type ImageAssignmentSource,
} from './image-reconcile-support.js';

export {
  canDeleteManagedImage,
  selectImageForAssignment,
  type ImageAssignmentSource,
} from './image-reconcile-support.js';

/**
 * Keeps each server's copy of a catalog image in line with the desired
 * fingerprint: pull, alias, supersede the previous copy, and remove copies
 * nothing needs. The Incus steps live in image-physical / image-assignment-deletion;
 * all SQL is in the store.
 */
@Injectable()
export class ImageAssignmentReconciler implements ManagedReconciler, OnModuleInit {
  readonly resourceType = 'image_assignment' as const;
  private readonly source: ImageAssignmentSource;
  private readonly pulls = new Map<string, Promise<void>>();
  private readonly store: ImageReconcileStore;
  private readonly deps: ImageReconcileDeps;

  constructor(
    @Inject(PG_DATABASE) database: Kysely<NyabaseDatabase>,
    config: NyabaseConfigService,
    private readonly intents: IntentRepository,
    audit: AuditService,
    private readonly registry: ReconcilerRegistry,
  ) {
    const dedicated = config.get<string>('incus.imageSourceServer');
    this.source = {
      alias: '',
      fingerprint: null,
      sourceServer: dedicated || config.get<string>('incus.preflightSourceServer'),
    };
    this.store = new ImageReconcileStore(database);
    this.deps = { store: this.store, audit };
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
      adminCapability: Capability.ManageImages,
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
        return reconcileImageCleanup(this.deps, context);
      }
      return {
        outcome: 'failed',
        failure: imageFailure(
          'IMAGE_ASSIGNMENT_NOT_FOUND',
          'The image assignment no longer exists',
        ),
      };
    }
    if (context.intent.serverId && context.intent.serverId !== assignment.server_id) {
      return {
        outcome: 'failed',
        failure: imageFailure(
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
      return reconcileDeletion(
        this.deps,
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
        failure: imageFailure(
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
        failure: imageFailure('IMAGE_FINGERPRINT_MISSING', 'Incus returned an image without a fingerprint'),
      };
    }
    if (
      desired.fingerprint !== null
      && desired.fingerprint !== undefined
      && !sameFingerprint(fingerprint, desired.fingerprint)
    ) {
      return {
        outcome: 'failed',
        failure: imageFailure(
          'IMAGE_ASSIGNMENT_FINGERPRINT_MISMATCH',
          'The server image does not match the desired fingerprint',
          { desiredFingerprint: desired.fingerprint, observedFingerprint: fingerprint },
        ),
      };
    }
    const previous = assignment.managed_fingerprint;
    const imagesForAlias = (await client.listImages(1)).metadata;
    await ensureAliasOnFingerprint(
      this.deps,
      client,
      imagesForAlias,
      desired.alias,
      fingerprint,
      context.intent,
    );
    const previousInUse = await deletePreviousImageIfUnused(
      this.deps,
      client,
      previous,
      fingerprint,
      context.intent,
    );
    if (previousInUse) {
      return {
        outcome: 'failed',
        failure: imageFailure(
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
      await ensurePulled(this.deps, this.pulls, client, desired, assignment.server_id, context.intent);
    } catch (error) {
      if (isNotFound(error)) {
        return {
          outcome: 'failed',
          failure: imageFailure(
            'IMAGE_NOT_AVAILABLE',
            `The image alias ${desired.alias} is not available from the image server`,
          ),
        };
      }
      if (error instanceof ImagePullNotConfirmedError) {
        return {
          outcome: 'failed',
          failure: imageFailure(error.code, error.message, error.details),
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
        ? imageFailure(
          'IMAGE_ASSIGNMENT_FINGERPRINT_MISMATCH',
          'The server image did not match the pinned fingerprint after the pull',
          { desiredFingerprint: desired.fingerprint },
        )
        : imageFailure(
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
}
