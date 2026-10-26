import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import {
  AuditAction,
  Role,
  type ContainerPowerIntent,
  type ImageVersionDto,
  type ResourceLifecyclePhase,
} from '@nyabase/common';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { AuditService } from '../iam/audit.service.js';
import { assertActorRole } from '../iam/administration.js';
import { isoDate } from '../platform/domain-utils.js';
import { ReconcileWakeService } from '../reconcile/reconcile-wake.service.js';
import { afterCommit } from '../platform/post-commit.js';

const FINGERPRINT_RE = /^[0-9a-f]{64}$/;
/** Containers named in an IMAGE_VERSION_IN_USE refusal. */
const IN_USE_DETAIL_LIMIT = 20;

/** Remember a fingerprint the image is now pulled at; pulling a deleted version again restores it. */
export async function recordImageVersion(
  executor: Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase>,
  imageId: string,
  fingerprint: string,
  description: string | null,
): Promise<void> {
  await executor
    .insertInto('infra.image_versions')
    .values({ image_id: imageId, fingerprint: fingerprint.toLowerCase(), description })
    .onConflict((conflict) => conflict.columns(['image_id', 'fingerprint']).doUpdateSet({
      deleted_at: null,
      description: (expression) => expression.fn.coalesce(
        expression.ref('excluded.description'),
        expression.ref('infra.image_versions.description'),
      ),
    }))
    .execute();
}

/**
 * The versions of an image: the current fingerprint (new containers use it)
 * and every earlier one the servers keep for the containers created from it.
 * A version that is not current and that no container uses can be deleted:
 * its row becomes a tombstone and each server's full scan removes the copy
 * (`ImageAssignmentReconciler.scan`), so a server that is offline or busy
 * catches up later instead of the deletion being lost.
 */
@Injectable()
export class ImageVersionsService {
  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly transactions: PgTransactionManager,
    private readonly audit: AuditService,
    private readonly wake: ReconcileWakeService,
  ) {}

  async list(imageId: string): Promise<ImageVersionDto[]> {
    const image = await this.database
      .selectFrom('infra.images')
      .select(['id', 'fingerprint', 'description'])
      .where('id', '=', imageId)
      .executeTakeFirst();
    if (!image) throw new NotFoundException('Image not found');
    const [versions, containers] = await Promise.all([
      this.database
        .selectFrom('infra.image_versions')
        .select(['fingerprint', 'description', 'created_at'])
        .where('image_id', '=', imageId)
        .where('deleted_at', 'is', null)
        .execute(),
      this.database
        .selectFrom('control.containers as c')
        .innerJoin('iam.users as u', 'u.id', 'c.owner_id')
        .innerJoin('infra.servers as s', 's.id', 'c.server_id')
        .select([
          'c.id as id',
          'c.name as name',
          'c.owner_id as owner_id',
          'u.username as owner_name',
          'c.server_id as server_id',
          's.name as server_name',
          'c.lifecycle_phase as lifecycle_phase',
          'c.power_intent as power_intent',
          'c.image_fingerprint as image_fingerprint',
        ])
        .where('c.image_id', '=', imageId)
        .orderBy('c.name')
        .execute(),
    ]);

    const byFingerprint = new Map<string, ImageVersionDto>();
    const version = (fingerprint: string, description: string | null = null, createdAt: string | null = null) => {
      let entry = byFingerprint.get(fingerprint);
      if (!entry) {
        entry = {
          fingerprint,
          description,
          current: fingerprint === image.fingerprint,
          createdAt,
          containers: [],
          deletable: false,
        };
        byFingerprint.set(fingerprint, entry);
      }
      return entry;
    };
    for (const row of versions) version(row.fingerprint, row.description, isoDate(row.created_at));
    // Not yet recorded: an image whose first pull is still running.
    if (image.fingerprint) version(image.fingerprint, image.description);
    for (const row of containers) {
      version(row.image_fingerprint).containers.push({
        id: row.id,
        name: row.name,
        ownerId: row.owner_id,
        ownerName: row.owner_name,
        serverId: row.server_id,
        serverName: row.server_name,
        lifecyclePhase: row.lifecycle_phase as ResourceLifecyclePhase,
        powerIntent: row.power_intent as ContainerPowerIntent,
      });
    }
    const list = [...byFingerprint.values()];
    for (const entry of list) entry.deletable = !entry.current && entry.containers.length === 0;
    return list.sort((left, right) => (
      Number(right.current) - Number(left.current)
      || (right.createdAt ?? '').localeCompare(left.createdAt ?? '')
    ));
  }

  /**
   * Delete a version: refused for the current one and while any container (of
   * any phase: a parked or failed one may still need the copy to be recreated)
   * was created from it. The servers drop their copies on their next scans.
   */
  async delete(actorId: string, imageId: string, fingerprint: string): Promise<void> {
    if (!FINGERPRINT_RE.test(fingerprint)) {
      throw new BadRequestException({
        code: 'IMAGE_VERSION_INVALID',
        message: 'An image version is a 64-character lowercase hex fingerprint',
      });
    }
    await this.transactions.run(async (transaction) => {
      await assertActorRole(transaction, actorId, Role.Admin);
      // Repulls and container creation lock the image row too.
      const image = await transaction
        .selectFrom('infra.images')
        .select(['id', 'alias', 'fingerprint'])
        .where('id', '=', imageId)
        .forUpdate()
        .executeTakeFirst();
      if (!image) throw new NotFoundException('Image not found');
      if (image.fingerprint === fingerprint) {
        throw new ConflictException({
          code: 'IMAGE_VERSION_CURRENT',
          message: 'The current version cannot be deleted; new containers are created from it',
        });
      }
      const users = await transaction
        .selectFrom('control.containers')
        .select(['id', 'name'])
        .where('image_id', '=', imageId)
        .where('image_fingerprint', '=', fingerprint)
        .orderBy('name')
        .limit(IN_USE_DETAIL_LIMIT)
        .execute();
      if (users.length > 0) {
        throw new ConflictException({
          code: 'IMAGE_VERSION_IN_USE',
          message: 'Containers were created from this version; delete them first',
          details: { containers: users },
        });
      }
      const deleted = await transaction
        .updateTable('infra.image_versions')
        .set({ deleted_at: new Date() })
        .where('image_id', '=', imageId)
        .where('fingerprint', '=', fingerprint)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (Number(deleted.numUpdatedRows) === 0) {
        throw new NotFoundException({ code: 'IMAGE_VERSION_NOT_FOUND', message: 'Image version not found' });
      }
      await this.audit.append(transaction, actorId, AuditAction.DeleteImageVersion, imageId, 'image', {
        alias: image.alias,
        fingerprint,
      });
      afterCommit(transaction, () => this.wake.wake({ reason: 'scan' }));
    });
  }
}
