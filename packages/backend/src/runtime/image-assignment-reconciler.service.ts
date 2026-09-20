import { Inject, Injectable, Optional } from '@nestjs/common';
import { AuditAction, DEFAULT_IMAGE_SOURCE_SERVER } from '@nyabase/common';
import { Kysely, sql } from 'kysely';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import { AuditService } from '../audit/audit.service.js';
import {
  IncusError,
  requestAndWait,
  readAfterTimeout,
  type IncusClientPort,
  type IncusSchema,
} from '../incus/index.js';
import { IntentRepository, type IntentFailure, type IntentRecord } from './intent.repository.js';
import type {
  ManagedReconciler,
  ReconcileOutcome,
  ReconcileRunContext,
} from './reconcile-worker.service.js';

type Image = IncusSchema<'Image'>;
export const IMAGE_ASSIGNMENT_SOURCE = Symbol('IMAGE_ASSIGNMENT_SOURCE');

export interface ImageAssignmentSource {
  readonly alias: string;
  readonly fingerprint: string | null;
  readonly sourceServer: string;
  readonly imageType?: string;
}
interface AssignmentRow {
  id: string;
  image_id: string;
  server_id: string;
  generation: number;
  observed_fingerprint: string | null;
  managed_fingerprint: string | null;
  lifecycle_phase: 'provisioning' | 'active' | 'deleting' | 'failed';
  alias: string;
  desired_fingerprint: string | null;
  cleanup_generation: number;
}

interface ImageCleanupRow {
  id: string;
  fingerprint: string | null;
  is_active: boolean;
  deleting: boolean;
  cleanup_generation: number;
}

function imageFailure(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): IntentFailure {
  return { code, message, details };
}

async function auditIncusMutate(
  audit: AuditService | undefined,
  intent: IntentRecord,
  detail: {
    readonly method: string;
    readonly path: string;
    readonly instanceName?: string;
  },
): Promise<void> {
  if (!audit) return;
  await audit.log(
    intent.requestedBy,
    AuditAction.IncusMutate,
    intent.resourceId,
    intent.resourceType,
    {
      method: detail.method,
      path: detail.path,
      instanceName: detail.instanceName,
      serverId: intent.serverId,
      intentId: intent.id,
    },
  );
}

class ImagePullNotConfirmedError extends Error {
  readonly code: 'IMAGE_ASSIGNMENT_FINGERPRINT_MISMATCH' | 'IMAGE_NOT_AVAILABLE';
  readonly details: Record<string, unknown>;

  constructor(desired: ImageAssignmentSource) {
    const pinned = desired.fingerprint !== null && desired.fingerprint !== undefined;
    super(
      pinned
        ? 'The pulled image did not have the pinned fingerprint'
        : 'The pulled image alias was not present after the pull',
    );
    this.name = 'ImagePullNotConfirmedError';
    this.code = pinned ? 'IMAGE_ASSIGNMENT_FINGERPRINT_MISMATCH' : 'IMAGE_NOT_AVAILABLE';
    this.details = pinned
      ? { desiredFingerprint: desired.fingerprint }
      : { alias: desired.alias };
  }
}
function isNotFound(error: unknown): boolean {
  return error instanceof IncusError && error.code === 'INCUS_NOT_FOUND';
}

function imageFingerprint(image: Image | undefined): string | null {
  return image?.fingerprint ?? null;
}

function imageHasAlias(image: Image, alias: string): boolean {
  return (image.aliases ?? []).some((item) => item.name === alias);
}

function sameFingerprint(
  actual: string | null | undefined,
  desired: string | null | undefined,
): boolean {
  return actual !== null
    && actual !== undefined
    && desired !== null
    && desired !== undefined
    && actual.toLowerCase() === desired.toLowerCase();
}

export function selectImageForAssignment(
  images: readonly Image[],
  desired: Pick<ImageAssignmentSource, 'alias' | 'fingerprint'>,
): Image | undefined {
  if (desired.fingerprint !== null && desired.fingerprint !== undefined) {
    return images.find((image) => sameFingerprint(imageFingerprint(image), desired.fingerprint));
  }
  return images.find((image) => imageHasAlias(image, desired.alias));
}

export function canDeleteManagedImage(input: {
  readonly managedFingerprint: string | null;
  readonly actualFingerprint: string | null;
  readonly otherAssignment: boolean;
  readonly pinned: boolean;
  readonly usedBy: boolean;
}): boolean {
  return Boolean(
    input.managedFingerprint
    && sameFingerprint(input.actualFingerprint, input.managedFingerprint)
    && !input.otherAssignment
    && !input.pinned
    && !input.usedBy,
  );
}

@Injectable()
export class ImageAssignmentReconciler implements ManagedReconciler {
  private readonly source: ImageAssignmentSource;
  private readonly pulls = new Map<string, Promise<void>>();

  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    @Optional() @Inject(IMAGE_ASSIGNMENT_SOURCE) source?: ImageAssignmentSource,
    @Optional() private readonly intents?: IntentRepository,
    @Optional() private readonly audit?: AuditService,
  ) {
    this.source = source ?? {
      alias: '',
      fingerprint: null,
      sourceServer: DEFAULT_IMAGE_SOURCE_SERVER,
    };
  }

  supports(intent: IntentRecord): boolean {
    return intent.resourceType === 'image_assignment';
  }

  async scan(
    serverId: string,
    client?: IncusClientPort,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.intents) return;
    const rows = await this.database
      .selectFrom('infra.image_server_assignments as a')
      .innerJoin('infra.images as i', 'i.id', 'a.image_id')
      .select([
        'a.id as id',
        'a.image_id as image_id',
        'a.server_id as server_id',
        'a.generation as generation',
        'a.observed_fingerprint as observed_fingerprint',
        'a.managed_fingerprint as managed_fingerprint',
        'a.lifecycle_phase as lifecycle_phase',
        'i.alias as alias',
        'i.fingerprint as desired_fingerprint',
        'i.cleanup_generation as cleanup_generation',
      ])
      .where('a.server_id', '=', serverId)
      .where('a.lifecycle_phase', '!=', 'failed')
      .execute();
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
        : images?.find((image) => imageHasAlias(image, desired.alias))
          ?? this.selectDesiredImage(images ?? [], desired);
      const idempotencyKey = images
        ? [
          'image-scan',
          row.lifecycle_phase,
          row.generation,
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
        targetGeneration: row.generation,
        request: {
          source: 'full_scan',
          ...(idempotencyKey ? { idempotencyKey } : {}),
        },
      });
    }

    const imageRows = await this.database
      .selectFrom('infra.images')
      .select(['id', 'cleanup_generation'])
      .where('is_active', '=', false)
      .where('deleting', '=', true)
      .execute();
    const assignedImageIds = new Set((await this.database
      .selectFrom('infra.image_server_assignments')
      .select('image_id')
      .execute()).map((row) => row.image_id));
    const cleanupOwner = await this.database
      .selectFrom('infra.servers')
      .select('id')
      .orderBy('id')
      .executeTakeFirst();
    if (cleanupOwner?.id === serverId) {
      for (const image of imageRows) {
        if (assignedImageIds.has(image.id)) continue;
        const generation = Math.max(1, image.cleanup_generation);
        await this.intents.ensurePending({
          kind: 'image_assignment.delete',
          resourceType: 'image_assignment',
          resourceId: image.id,
          serverId,
          targetGeneration: generation,
          request: {
            operation: 'cleanup_image',
            imageId: image.id,
            source: 'full_scan',
            idempotencyKey: `image-cleanup:${generation}`,
          },
        });
      }
    }
  }

  async reconcile(context: ReconcileRunContext): Promise<ReconcileOutcome> {
    if (!context.client) {
      throw new IncusError('SERVER_UNREACHABLE', 'retry', { reason: 'missing_client' });
    }
    const assignment = await this.readAssignment(context.intent.resourceId);
    if (!assignment) {
      if (context.intent.kind === 'image_assignment.delete') {
        return this.reconcileImageCleanup(context);
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
    const actual = this.selectDesiredImage(images, desired);
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
    if (
      assignment.managed_fingerprint
      && desired.fingerprint !== null
      && desired.fingerprint !== undefined
      && !sameFingerprint(assignment.managed_fingerprint, desired.fingerprint)
    ) {
      return {
        outcome: 'failed',
        failure: imageFailure(
          'IMAGE_ASSIGNMENT_FINGERPRINT_MISMATCH',
          'The managed image fingerprint changed without a cleanup intent',
          {
            managedFingerprint: assignment.managed_fingerprint,
            desiredFingerprint: desired.fingerprint,
          },
        ),
      };
    }

    let resolved = actual;
    if (!resolved) {
      try {
        await this.ensurePulled(context.client!, desired, assignment.server_id, context.intent);
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
      const refreshed = (await context.client.listImages(1)).metadata;
      resolved = this.selectDesiredImage(refreshed, desired);
    }
    if (!resolved) {
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
    await this.database
      .updateTable('infra.image_server_assignments')
      .set({
        observed_fingerprint: fingerprint,
        managed_fingerprint: fingerprint,
        lifecycle_phase: 'active',
        needs_attention: false,
        failure_code: null,
        failure_reason: null,
        last_observed_at: sql<Date>`clock_timestamp()`,
      })
      .where('id', '=', assignment.id)
      .execute();
    await this.database
      .updateTable('infra.images')
      .set({ fingerprint })
      .where('id', '=', assignment.image_id)
      .execute();
    return { outcome: 'succeeded', observedGeneration: assignment.generation };
  }

  private desiredSource(assignment: AssignmentRow): ImageAssignmentSource {
    return {
      alias: assignment.alias || this.source.alias,
      fingerprint: assignment.desired_fingerprint ?? this.source.fingerprint,
      sourceServer: this.source.sourceServer,
      imageType: this.source.imageType,
    };
  }

  private async reconcileImageCleanup(
    context: ReconcileRunContext,
  ): Promise<ReconcileOutcome> {
    const image = await this.readImage(context.intent.resourceId);
    if (!image) {
      return {
        outcome: 'succeeded',
        observedGeneration: context.intent.targetGeneration,
      };
    }
    if (
      context.intent.request?.operation !== 'cleanup_image'
      || image.is_active
      || !image.deleting
    ) {
      return {
        outcome: 'failed',
        failure: imageFailure(
          'IMAGE_ASSIGNMENT_NOT_FOUND',
          'The image assignment no longer exists',
        ),
      };
    }
    const assignments = await this.database
      .selectFrom('infra.image_server_assignments')
      .select('id')
      .where('image_id', '=', image.id)
      .execute();
    if (assignments.length > 0) {
      return {
        outcome: 'retry',
        retryAfterMs: 5_000,
        failure: imageFailure(
          'IMAGE_CLEANUP_ASSIGNMENTS_PRESENT',
          'The image still has server assignments to clean up',
          { assignmentCount: assignments.length },
        ),
      };
    }
    const retainedContainer = await this.database
      .selectFrom('control.containers')
      .select('id')
      .where('image_id', '=', image.id)
      .executeTakeFirst();
    if (retainedContainer) {
      return {
        outcome: 'retry',
        retryAfterMs: 5_000,
        failure: imageFailure(
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
      const images = (await context.client.listImages(1, { signal: context.signal })).metadata;
      const physical = images.find((candidate) =>
        sameFingerprint(imageFingerprint(candidate), image.fingerprint));
      if (physical) {
        const usedBy = (physical as Image & { used_by?: string[] }).used_by ?? [];
        if (usedBy.length > 0) {
          return {
            outcome: 'retry',
            retryAfterMs: 5_000,
            failure: imageFailure(
              'IMAGE_CLEANUP_BLOCKED',
              'The inactive image is still used by an Incus resource',
              { fingerprint: image.fingerprint, usedBy },
            ),
          };
        }
        await auditIncusMutate(this.audit, context.intent, {
          method: 'DELETE',
          path: `/1.0/images/${image.fingerprint}`,
          instanceName: image.fingerprint,
        });
        await readAfterTimeout(
          () => requestAndWait(
            context.client!,
            (options) => context.client!.deleteImage(image.fingerprint!, options),
          ),
          async () => {
            try {
              await context.client!.getImage(image.fingerprint!);
            } catch (error) {
              if (isNotFound(error)) return undefined;
              throw error;
            }
            throw new Error('IMAGE_DELETE_NOT_CONFIRMED');
          },
        );
        try {
          await context.client!.getImage(image.fingerprint);
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
      }
    }
    await this.database
      .deleteFrom('infra.images')
      .where('id', '=', image.id)
      .where('is_active', '=', false)
      .where('deleting', '=', true)
      .execute();
    return {
      outcome: 'succeeded',
      observedGeneration: context.intent.targetGeneration,
    };
  }

  private async ensurePulled(
    client: IncusClientPort,
    desired: ImageAssignmentSource,
    serverId: string,
    intent: IntentRecord,
  ): Promise<void> {
    const key = `${serverId}|${desired.sourceServer}|${desired.alias}|${desired.fingerprint ?? ''}|${desired.imageType ?? 'container'}`;
    const existing = this.pulls.get(key);
    if (existing) {
      await existing;
      return;
    }
    const pull: Promise<void> = (async () => {
      await auditIncusMutate(this.audit, intent, {
        method: 'POST',
        path: '/1.0/images',
        instanceName: desired.fingerprint ?? desired.alias,
      });
      await readAfterTimeout(
        () => requestAndWait(
          client,
          (options) => client.createImage(
            {
              source: {
                type: 'image',
                alias: desired.alias,
                fingerprint: desired.fingerprint ?? undefined,
                protocol: 'simplestreams',
                server: desired.sourceServer,
                image_type: desired.imageType ?? 'container',
              },
              aliases: [{ name: desired.alias }],
            },
            options,
          ),
        ),
        async () => {
          const retryImages = (await client.listImages(1)).metadata;
          const retryImage = selectImageForAssignment(retryImages, desired);
          if (
            !retryImage
            || (
              desired.fingerprint !== null
              && desired.fingerprint !== undefined
              && !sameFingerprint(imageFingerprint(retryImage), desired.fingerprint)
            )
          ) {
            throw new ImagePullNotConfirmedError(desired);
          }
          return undefined;
        },
      );
    })();
    this.pulls.set(key, pull);
    try {
      await pull;
    } finally {
      this.pulls.delete(key);
    }
  }

  private selectDesiredImage(
    images: readonly Image[],
    desired: ImageAssignmentSource,
  ): Image | undefined {
    return selectImageForAssignment(images, desired);
  }

  private async reconcileDeletion(
    client: IncusClientPort,
    assignment: AssignmentRow,
    images: readonly Image[],
    selected: Image | undefined,
    intent: IntentRecord,
  ): Promise<ReconcileOutcome> {
    const managed = assignment.managed_fingerprint;
    if (!managed) {
      await this.markAssignmentDeleted(assignment, !selected);
      return { outcome: 'succeeded', observedGeneration: assignment.generation };
    }
    if (selected && !sameFingerprint(imageFingerprint(selected), managed)) {
      return {
        outcome: 'failed',
        failure: imageFailure(
          'IMAGE_ASSIGNMENT_FINGERPRINT_MISMATCH',
          'The assignment managed fingerprint no longer identifies the selected image',
          { managedFingerprint: managed, observedFingerprint: imageFingerprint(selected) },
        ),
      };
    }
    const image = images.find((candidate) => sameFingerprint(imageFingerprint(candidate), managed));
    if (!image) {
      await this.markAssignmentDeleted(assignment, true);
      return { outcome: 'succeeded', observedGeneration: assignment.generation };
    }
    const otherAssignment = await this.database
      .selectFrom('infra.image_server_assignments')
      .select('id')
      .where('server_id', '=', assignment.server_id)
      .where('id', '!=', assignment.id)
      .where('lifecycle_phase', '!=', 'deleting')
      .where((expression) => expression.or([
        expression('managed_fingerprint', '=', managed),
        expression('observed_fingerprint', '=', managed),
      ]))
      .executeTakeFirst();
    const pinned = await this.database
      .selectFrom('control.containers')
      .select('id')
      .where('server_id', '=', assignment.server_id)
      .where('image_fingerprint', '=', managed)
      .where('lifecycle_phase', '!=', 'deleting')
      .executeTakeFirst();
    const usedBy = (image as Image & { used_by?: string[] }).used_by ?? [];
    if (!canDeleteManagedImage({
      managedFingerprint: managed,
      actualFingerprint: imageFingerprint(image),
      otherAssignment: Boolean(otherAssignment),
      pinned: Boolean(pinned),
      usedBy: usedBy.length > 0,
    })) {
      await this.markAssignmentDeleted(assignment, false);
      return { outcome: 'succeeded', observedGeneration: assignment.generation };
    }
    await auditIncusMutate(this.audit, intent, {
      method: 'DELETE',
      path: `/1.0/images/${managed}`,
      instanceName: managed,
    });
    await readAfterTimeout(
      () => requestAndWait(client, (options) => client.deleteImage(managed, options)),
      async () => {
        try {
          await client.getImage(managed);
        } catch (error) {
          if (isNotFound(error)) return undefined;
          throw error;
        }
        throw new Error('IMAGE_DELETE_NOT_CONFIRMED');
      },
    );
    try {
      await client.getImage(managed);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    await this.database
      .updateTable('infra.images')
      .set({ cleanup_generation: sql<number>`cleanup_generation + 1` })
      .where('id', '=', assignment.image_id)
      .execute();
    await this.markAssignmentDeleted(assignment, true);
    return { outcome: 'succeeded', observedGeneration: assignment.generation };
  }

  private async markAssignmentDeleted(
    assignment: AssignmentRow,
    physicalGone: boolean,
  ): Promise<void> {
    await this.database
      .deleteFrom('infra.image_server_assignments')
      .where('id', '=', assignment.id)
      .execute();
    if (!physicalGone) return;
    const remainingAssignment = await this.database
      .selectFrom('infra.image_server_assignments')
      .select('id')
      .where('image_id', '=', assignment.image_id)
      .executeTakeFirst();
    if (remainingAssignment) return;
    const retainedContainer = await this.database
      .selectFrom('control.containers')
      .select('id')
      .where('image_id', '=', assignment.image_id)
      .executeTakeFirst();
    if (retainedContainer) return;
    await this.database
      .deleteFrom('infra.images')
      .where('id', '=', assignment.image_id)
      .where('is_active', '=', false)
      .where('deleting', '=', true)
      .execute();
  }

  private async readImage(id: string): Promise<ImageCleanupRow | undefined> {
    return this.database
      .selectFrom('infra.images')
      .select(['id', 'fingerprint', 'is_active', 'deleting', 'cleanup_generation'])
      .where('id', '=', id)
      .executeTakeFirst();
  }

  private async readAssignment(id: string): Promise<AssignmentRow | undefined> {
    const row = await this.database
      .selectFrom('infra.image_server_assignments as a')
      .innerJoin('infra.images as i', 'i.id', 'a.image_id')
      .select([
        'a.id as id',
        'a.image_id as image_id',
        'a.server_id as server_id',
        'a.generation as generation',
        'a.observed_fingerprint as observed_fingerprint',
        'a.managed_fingerprint as managed_fingerprint',
        'a.lifecycle_phase as lifecycle_phase',
        'i.alias as alias',
        'i.fingerprint as desired_fingerprint',
        'i.cleanup_generation as cleanup_generation',
      ])
      .where('a.id', '=', id)
      .executeTakeFirst();
    return row;
  }
}
