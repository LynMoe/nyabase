import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import { randomUUID } from 'node:crypto';
import {
  AuditAction,
  Capability,
  IntentKind,
  IntentResourceType,
  MAX_PLATFORM_IMAGES,
  type AdminImageDto,
  type AddCatalogImageRequest,
  type CatalogImageDto,
  type CreateImageRequest,
  type ImageAssignmentDto,
  type ImageDto,
  type PatchImageRequest,
  type ResourceLifecyclePhase,
} from '@nyabase/common';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { AccessResolverService } from '../access/access-resolver.service.js';
import { AuditService } from '../audit/audit.service.js';
import { InfrastructureRepository } from '../infrastructure/infrastructure.repository.js';
import { IntentRepository } from '../runtime/intent.repository.js';
import { ReconcileWakeService } from '../runtime/reconcile-wake.service.js';
import { isoDate, numberValue, acceptedIntent } from '../domain/domain-utils.js';
import { ImageCatalogService } from './image-catalog.js';

type ImageRow = Awaited<ReturnType<ImagesService['findById']>>;
type ImageAssignmentRow = Awaited<ReturnType<ImagesService['assignments']>>[number];

function isUniqueViolation(error: unknown): boolean {
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

@Injectable()
export class ImagesService {
  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly transactions: PgTransactionManager,
    private readonly access: AccessResolverService,
    private readonly audit: AuditService,
    private readonly intents: IntentRepository,
    private readonly wake: ReconcileWakeService,
    @Optional() private readonly infrastructure?: InfrastructureRepository,
    @Optional() private readonly catalog?: ImageCatalogService,
  ) {}

  async listCatalog(): Promise<CatalogImageDto[]> {
    if (!this.catalog) {
      throw new ConflictException({ code: 'IMAGE_CATALOG_UNAVAILABLE', message: 'Image catalog is not configured' });
    }
    const entries = await this.catalog.list();
    const existing = await this.database.selectFrom('infra.images').select(['alias']).execute();
    const occupied = new Set(existing.map((row) => row.alias));
    return entries.map((entry) => ({
      ...entry,
      added: occupied.has(entry.alias) || entry.aliases.some((alias) => occupied.has(alias)),
    }));
  }

  async addFromCatalog(actorId: string, input: AddCatalogImageRequest): Promise<AdminImageDto> {
    if (!this.catalog) {
      throw new ConflictException({ code: 'IMAGE_CATALOG_UNAVAILABLE', message: 'Image catalog is not configured' });
    }
    const entry = await this.catalog.requireAlias(input.alias);
    const existing = await this.database.selectFrom('infra.images')
      .select(['id', 'deleting'])
      .where('alias', '=', entry.alias)
      .executeTakeFirst();
    if (existing) {
      throw new ConflictException({
        code: existing.deleting ? 'IMAGE_ALIAS_DELETING' : 'IMAGE_ALIAS_EXISTS',
        message: existing.deleting
          ? `Image alias ${entry.alias} is still being removed`
          : `Image alias ${entry.alias} is already in the catalog`,
      });
    }
    try {
      return await this.create(actorId, {
        alias: entry.alias,
        description: entry.description,
        loginUser: 'root',
        minRootSizeBytes: null,
        networkManagedExternally: true,
      }, entry.fingerprint);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      throw new ConflictException({
        code: 'IMAGE_ALIAS_EXISTS',
        message: `Image alias ${entry.alias} is already in the catalog`,
      });
    }
  }

  async repull(actorId: string, imageId: string): Promise<{
    image: AdminImageDto;
    intents: Array<Awaited<ReturnType<IntentRepository['ensurePending']>>>;
  }> {
    if (!this.catalog) {
      throw new ConflictException({ code: 'IMAGE_CATALOG_UNAVAILABLE', message: 'Image catalog is not configured' });
    }
    const current = await this.findById(imageId);
    const entry = await this.catalog.requireAlias(current.alias);
    const result = await this.transactions.run(async (transaction) => {
      await this.access.assertActorCapabilitiesInTransaction(
        transaction,
        actorId,
        [Capability.ManageImages],
      );
      const image = await this.lockById(imageId, transaction);
      if (!image.is_active || image.deleting) {
        throw new ConflictException({
          code: 'IMAGE_NOT_ASSIGNABLE',
          message: 'A deleting or inactive image cannot be pulled',
        });
      }
      const updated = await transaction.updateTable('infra.images')
        .set({
          fingerprint: entry.fingerprint,
          description: entry.description,
          revision: Number(image.revision) + 1,
          updated_at: new Date(),
        })
        .where('id', '=', imageId)
        .where('revision', '=', image.revision)
        .returningAll()
        .executeTakeFirstOrThrow();
      const assignments = await transaction
        .selectFrom('infra.image_server_assignments')
        .selectAll()
        .where('image_id', '=', imageId)
        .where('lifecycle_phase', '!=', 'deleting')
        .forUpdate()
        .execute();
      const intents = [];
      for (const assignment of assignments) {
        const next = await transaction
          .updateTable('infra.image_server_assignments')
          .set({
            generation: assignment.generation + 1,
            lifecycle_phase: 'provisioning',
            needs_attention: false,
            failure_code: null,
            failure_reason: null,
            updated_at: new Date(),
          })
          .where('id', '=', assignment.id)
          .where('generation', '=', assignment.generation)
          .returningAll()
          .executeTakeFirstOrThrow();
        intents.push(await this.intents.ensurePending({
          kind: IntentKind.ImageAssignmentEnsure,
          resourceType: IntentResourceType.ImageAssignment,
          resourceId: next.id,
          serverId: next.server_id,
          requestedBy: actorId,
          targetGeneration: next.generation,
          request: { operation: 'repull', imageId, serverId: next.server_id },
        }, transaction));
      }
      await this.audit.append(transaction, actorId, AuditAction.UpdateImage, updated.id, 'image', {
        alias: updated.alias,
        fingerprint: updated.fingerprint,
        assignmentCount: assignments.length,
      });
      return { image: updated, intents };
    });
    for (const intent of result.intents) {
      if (!intent.serverId) continue;
      this.wake.wake({
        resourceType: IntentResourceType.ImageAssignment,
        resourceId: intent.resourceId,
        serverId: intent.serverId,
        reason: 'intent',
      });
    }
    return {
      image: await this.toAdminDto(result.image),
      intents: result.intents,
    };
  }

  async create(actorId: string, input: CreateImageRequest, fingerprint: string | null = null): Promise<AdminImageDto> {
    const row = await this.transactions.run(async (transaction) => {
      await this.access.assertActorCapabilitiesInTransaction(
        transaction,
        actorId,
        [Capability.ManageImages],
      );
      await this.infrastructure?.lockImageCapacity(transaction);
      const count = await transaction.selectFrom('infra.images')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .executeTakeFirstOrThrow();
      if (Number(count.count) >= MAX_PLATFORM_IMAGES) {
        throw new ConflictException({
          code: 'IMAGE_CAPACITY_REACHED',
          message: `At most ${MAX_PLATFORM_IMAGES} images are supported`,
        });
      }
      let created;
      try {
        created = await transaction.insertInto('infra.images')
          .values({
            id: randomUUID(),
            alias: input.alias,
            fingerprint,
            description: input.description ?? null,
            login_user: input.loginUser,
            min_root_size_bytes: input.minRootSizeBytes ?? null,
            network_managed_externally: input.networkManagedExternally,
            is_active: true,
            deleting: false,
            cleanup_generation: 0,
            revision: 1,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        throw new ConflictException({
          code: 'IMAGE_ALIAS_EXISTS',
          message: `Image alias ${input.alias} is already in the catalog`,
        });
      }
      await this.audit.append(transaction, actorId, AuditAction.CreateImage, created.id, 'image', {
        alias: created.alias,
      });
      return created;
    });
    return this.toAdminDto(row);
  }

  async findAllAdmin(activeOnly = false): Promise<AdminImageDto[]> {
    let query = this.database.selectFrom('infra.images').selectAll().orderBy('alias');
    if (activeOnly) query = query.where('is_active', '=', true);
    const rows = await query.execute();
    return Promise.all(rows.map((row) => this.toAdminDto(row)));
  }

  async findAccessibleForUser(userId: string, activeOnly: boolean): Promise<ImageDto[]> {
    const access = await this.access.getEffectiveAccess(userId);
    const allowed = new Set(access.flatMap((server) => server.allowedImageIds));
    if (allowed.size === 0) return [];
    let query = this.database.selectFrom('infra.images')
      .selectAll()
      .where('id', 'in', [...allowed])
      .where('deleting', '=', false);
    if (activeOnly) query = query.where('is_active', '=', true);
    return (await query.execute()).map((row) => this.toDto(row));
  }

  async findById(id: string, executor: Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase> = this.database) {
    const row = await executor.selectFrom('infra.images')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Image not found');
    return row;
  }

  private async lockById(
    id: string,
    transaction: Transaction<NyabaseDatabase>,
  ) {
    const row = await transaction.selectFrom('infra.images')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Image not found');
    return row;
  }

  async findAdminDtoById(id: string): Promise<AdminImageDto> {
    return this.toAdminDto(await this.findById(id));
  }

  toDto(image: ImageRow): ImageDto {
    return {
      id: image.id,
      alias: image.alias,
      fingerprint: image.fingerprint,
      description: image.description,
      loginUser: image.login_user,
      minRootSizeBytes: image.min_root_size_bytes === null
        ? null
        : numberValue(image.min_root_size_bytes),
      networkManagedExternally: image.network_managed_externally,
      isActive: image.is_active,
      deleting: image.deleting,
      cleanupGeneration: image.cleanup_generation,
      revision: numberValue(image.revision),
      createdAt: new Date(image.created_at).toISOString(),
      updatedAt: new Date(image.updated_at).toISOString(),
    };
  }

  async update(
    actorId: string,
    id: string,
    input: PatchImageRequest,
  ): Promise<AdminImageDto> {
    const row = await this.transactions.run(async (transaction) => {
      await this.access.assertActorCapabilitiesInTransaction(
        transaction,
        actorId,
        [Capability.ManageImages],
      );
      const current = await this.lockById(id, transaction);
      const updated = await transaction.updateTable('infra.images')
        .set({
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.minRootSizeBytes === undefined
            ? {}
            : { min_root_size_bytes: input.minRootSizeBytes }),
          ...(input.networkManagedExternally === undefined
            ? {}
            : { network_managed_externally: input.networkManagedExternally }),
          ...(input.isActive === undefined ? {} : { is_active: input.isActive }),
          revision: Number(current.revision) + 1,
          updated_at: new Date(),
        })
        .where('id', '=', id)
        .where('revision', '=', String(input.expectedRevision))
        .returningAll()
        .executeTakeFirst();
      if (!updated) throw new ConflictException({ code: 'REVISION_CONFLICT' });
      await this.audit.append(transaction, actorId, AuditAction.UpdateImage, id, 'image', input);
      return updated;
    });
    return this.toAdminDto(row);
  }

  async delete(actorId: string, id: string) {
    const result = await this.transactions.run(async (transaction) => {
      await this.access.assertActorCapabilitiesInTransaction(
        transaction,
        actorId,
        [Capability.ManageImages],
      );
      const current = await this.lockById(id, transaction);
      const container = await transaction.selectFrom('control.containers')
        .select('id')
        .where('image_id', '=', id)
        .where('lifecycle_phase', 'not in', ['failed', 'deleting'])
        .executeTakeFirst();
      if (container) {
        throw new ConflictException({
          code: 'IMAGE_IN_USE',
          message: 'Image is still used by a retained container',
        });
      }
      if (current.deleting) {
        const intents = await this.scheduleAssignmentDeletes(transaction, actorId, id);
        await this.audit.append(transaction, actorId, AuditAction.DeleteImage, id, 'image', {
          idempotent: true,
        });
        return { updated: current, intents };
      }
      const assignments = await this.assignments(id, transaction);
      const updated = await transaction.updateTable('infra.images')
        .set({
          is_active: false,
          deleting: true,
          cleanup_generation: current.cleanup_generation + 1,
          revision: Number(current.revision) + 1,
        })
        .where('id', '=', id)
        .where('revision', '=', current.revision)
        .returningAll()
        .executeTakeFirstOrThrow();
      const intents = [];
      for (const assignment of assignments) {
        intents.push(...await this.scheduleAssignmentDelete(
          transaction,
          actorId,
          id,
          assignment,
        ));
      }
      await this.audit.append(transaction, actorId, AuditAction.DeleteImage, id, 'image');
      return { updated, intents };
    });
    for (const intent of result.intents) {
      this.wake.wake({
        resourceType: IntentResourceType.ImageAssignment,
        resourceId: intent.resourceId,
        serverId: intent.serverId,
        reason: 'intent',
      });
    }
    return result.intents.length > 0
      ? result.intents.map((intent) => acceptedIntent(intent))
      : this.toDto(result.updated);
  }

  async getServerStatuses(image: ImageRow) {
    const assignments = await this.assignments(image.id);
    const servers = assignments.length === 0
      ? []
      : await this.database.selectFrom('infra.servers')
        .select(['id', 'name', 'api_endpoint', 'status'])
        .where('id', 'in', assignments.map((assignment) => assignment.server_id))
        .execute();
    const serverById = new Map(servers.map((server) => [server.id, server]));
    return assignments.map((assignment) => ({
      serverId: assignment.server_id,
      serverName: serverById.get(assignment.server_id)?.name ?? assignment.server_id,
      hostname: serverById.get(assignment.server_id)?.api_endpoint ?? assignment.server_id,
      online: serverById.get(assignment.server_id)?.status === 'online',
      present: assignment.lifecycle_phase === 'active'
        && assignment.managed_fingerprint === image.fingerprint,
      assignment: this.assignmentDto(assignment),
    }));
  }

  async ensureAssignment(
    actorId: string,
    imageId: string,
    serverId: string,
    expectedGeneration?: number,
  ): Promise<{
    assignment: ImageAssignmentDto;
    intent: Awaited<ReturnType<IntentRepository['ensurePending']>>;
  }> {
    const result = await this.transactions.run(async (transaction) => {
      await this.access.assertActorCapabilitiesInTransaction(
        transaction,
        actorId,
        [Capability.ManageImages],
      );
      const image = await this.lockById(imageId, transaction);
      if (!image.is_active || image.deleting) {
        throw new ConflictException({
          code: 'IMAGE_NOT_ASSIGNABLE',
          message: 'A deleting or inactive image cannot receive assignments',
        });
      }
      const server = await transaction.selectFrom('infra.servers')
        .select('id')
        .where('id', '=', serverId)
        .executeTakeFirst();
      if (!server) throw new NotFoundException('Server not found');
      const current = await transaction
        .selectFrom('infra.image_server_assignments')
        .selectAll()
        .where('image_id', '=', imageId)
        .where('server_id', '=', serverId)
        .forUpdate()
        .executeTakeFirst();
      if (
        current
        && expectedGeneration !== undefined
        && current.generation !== expectedGeneration
      ) {
        throw new ConflictException({ code: 'GENERATION_CONFLICT' });
      }
      let assignment: ImageAssignmentRow;
      if (!current) {
        assignment = await transaction
          .insertInto('infra.image_server_assignments')
          .values({
            id: randomUUID(),
            image_id: imageId,
            server_id: serverId,
            generation: 1,
            observed_fingerprint: null,
            managed_fingerprint: null,
            lifecycle_phase: 'provisioning',
            needs_attention: false,
            failure_code: null,
            failure_reason: null,
            last_observed_at: null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      } else if (current.lifecycle_phase === 'provisioning' || current.lifecycle_phase === 'active') {
        // PUT is idempotent while the desired state is already present.
        assignment = current;
      } else {
        const pendingDelete = await transaction
          .selectFrom('control.intents')
          .select('id')
          .where('resource_type', '=', IntentResourceType.ImageAssignment)
          .where('resource_id', '=', current.id)
          .where('kind', '=', IntentKind.ImageAssignmentDelete)
          .where('status', '=', 'pending')
          .executeTakeFirst();
        if (pendingDelete) {
          throw new ConflictException({
            code: 'IMAGE_ASSIGNMENT_DELETE_PENDING',
            message: 'The assignment cannot be re-enabled until cleanup settles',
          });
        }
        assignment = await transaction
          .updateTable('infra.image_server_assignments')
          .set({
            generation: current.generation + 1,
            lifecycle_phase: 'provisioning',
            needs_attention: false,
            failure_code: null,
            failure_reason: null,
            updated_at: new Date(),
          })
          .where('id', '=', current.id)
          .where('generation', '=', current.generation)
          .returningAll()
          .executeTakeFirstOrThrow();
      }
      const intent = await this.intents.ensurePending({
        kind: IntentKind.ImageAssignmentEnsure,
        resourceType: IntentResourceType.ImageAssignment,
        resourceId: assignment.id,
        serverId,
        requestedBy: actorId,
        targetGeneration: assignment.generation,
        request: { operation: 'ensure', imageId, serverId },
      }, transaction);
      await this.audit.append(
        transaction,
        actorId,
        AuditAction.EnsureImageAssignment,
        assignment.id,
        'image_assignment',
        { imageId, serverId, generation: assignment.generation },
      );
      return { assignment, intent };
    });
    this.wake.wake({
      resourceType: IntentResourceType.ImageAssignment,
      resourceId: result.assignment.id,
      serverId,
      reason: 'intent',
    });
    return {
      assignment: this.assignmentDto(result.assignment),
      intent: result.intent,
    };
  }

  async deleteAssignment(
    actorId: string,
    imageId: string,
    serverId: string,
    expectedGeneration?: number,
  ): Promise<{
    assignment: ImageAssignmentDto | null;
    intents: Array<Awaited<ReturnType<IntentRepository['ensurePending']>>>;
  }> {
    const result = await this.transactions.run(async (transaction) => {
      await this.access.assertActorCapabilitiesInTransaction(
        transaction,
        actorId,
        [Capability.ManageImages],
      );
      const image = await this.findById(imageId, transaction);
      const assignment = await transaction
        .selectFrom('infra.image_server_assignments')
        .selectAll()
        .where('image_id', '=', imageId)
        .where('server_id', '=', serverId)
        .forUpdate()
        .executeTakeFirst();
      if (!assignment) return { assignment: null, intents: [] };
      if (
        expectedGeneration !== undefined
        && assignment.generation !== expectedGeneration
      ) {
        throw new ConflictException({ code: 'GENERATION_CONFLICT' });
      }
      const intents = await this.scheduleAssignmentDelete(
        transaction,
        actorId,
        imageId,
        assignment,
      );
      const current = await transaction
        .selectFrom('infra.image_server_assignments')
        .selectAll()
        .where('id', '=', assignment.id)
        .executeTakeFirstOrThrow();
      await this.audit.append(
        transaction,
        actorId,
        AuditAction.DeleteImageAssignment,
        assignment.id,
        'image_assignment',
        {
          imageId,
          serverId,
          generation: current.generation,
          imageDeleting: image.deleting,
        },
      );
      return { assignment: current, intents };
    });
    if (result.assignment) {
      this.wake.wake({
        resourceType: IntentResourceType.ImageAssignment,
        resourceId: result.assignment.id,
        serverId,
        reason: 'intent',
      });
    }
    return {
      assignment: result.assignment ? this.assignmentDto(result.assignment) : null,
      intents: result.intents,
    };
  }

  private async toAdminDto(image: ImageRow): Promise<AdminImageDto> {
    const assignments = await this.assignments(image.id);
    return {
      ...this.toDto(image),
      assignments: assignments.map((assignment) => this.assignmentDto(assignment)),
    };
  }

  public assignments(
    imageId: string,
    executor: Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase> = this.database,
  ) {
    return executor.selectFrom('infra.image_server_assignments')
      .selectAll()
      .where('image_id', '=', imageId)
      .orderBy('server_id')
      .execute();
  }

  private assignmentDto(row: ImageAssignmentRow) {
    return {
      id: row.id,
      imageId: row.image_id,
      serverId: row.server_id,
      generation: row.generation,
      observedFingerprint: row.observed_fingerprint,
      managedFingerprint: row.managed_fingerprint,
      lifecyclePhase: row.lifecycle_phase as ResourceLifecyclePhase,
      needsAttention: row.needs_attention,
      failureCode: row.failure_code,
      failureReason: row.failure_reason,
      lastObservedAt: isoDate(row.last_observed_at),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  private async scheduleAssignmentDeletes(
    transaction: Transaction<NyabaseDatabase>,
    actorId: string,
    imageId: string,
  ): Promise<Array<Awaited<ReturnType<IntentRepository['ensurePending']>>>> {
    const assignments = await this.assignments(imageId, transaction);
    const intents: Array<Awaited<ReturnType<IntentRepository['ensurePending']>>> = [];
    for (const assignment of assignments) {
      intents.push(...await this.scheduleAssignmentDelete(
        transaction,
        actorId,
        imageId,
        assignment,
      ));
    }
    return intents;
  }

  private async scheduleAssignmentDelete(
    transaction: Transaction<NyabaseDatabase>,
    actorId: string,
    imageId: string,
    assignment: ImageAssignmentRow,
  ): Promise<Array<Awaited<ReturnType<IntentRepository['ensurePending']>>>> {
    let generation = assignment.generation;
    if (assignment.lifecycle_phase !== 'deleting') {
      const updated = await transaction
        .updateTable('infra.image_server_assignments')
        .set({
          generation: assignment.generation + 1,
          lifecycle_phase: 'deleting',
          needs_attention: false,
          failure_code: null,
          failure_reason: null,
          updated_at: new Date(),
        })
        .where('id', '=', assignment.id)
        .where('generation', '=', assignment.generation)
        .returning('generation')
        .executeTakeFirstOrThrow();
      generation = updated.generation;
    }
    const intent = await this.intents.ensurePending({
      kind: IntentKind.ImageAssignmentDelete,
      resourceType: IntentResourceType.ImageAssignment,
      resourceId: assignment.id,
      serverId: assignment.server_id,
      requestedBy: actorId,
      targetGeneration: generation,
      request: { operation: 'delete', imageId },
    }, transaction);
    return [intent];
  }
}
