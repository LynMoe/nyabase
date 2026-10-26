import { Inject, Injectable } from '@nestjs/common';
import { sql, type ExpressionBuilder, type Kysely } from 'kysely';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import type { IntentFailure } from '../reconcile/intent.repository.js';

export interface AssignmentRow {
  id: string;
  image_id: string;
  server_id: string;
  revision: number;
  observed_fingerprint: string | null;
  managed_fingerprint: string | null;
  lifecycle_phase: 'provisioning' | 'active' | 'deleting' | 'failed';
  alias: string;
  desired_fingerprint: string | null;
  cleanup_generation: number;
}

export interface ImageCleanupRow {
  id: string;
  fingerprint: string | null;
  is_active: boolean;
  deleting: boolean;
  cleanup_generation: number;
}

const ASSIGNMENT_COLUMNS = [
  'a.id as id',
  'a.image_id as image_id',
  'a.server_id as server_id',
  'a.revision as revision',
  'a.observed_fingerprint as observed_fingerprint',
  'a.managed_fingerprint as managed_fingerprint',
  'a.lifecycle_phase as lifecycle_phase',
  'i.alias as alias',
  'i.fingerprint as desired_fingerprint',
  'i.cleanup_generation as cleanup_generation',
] as const;

/**
 * Whether the server still needs its copy (`copy.fingerprint`): it is the
 * current fingerprint of any image, an assignment on the server manages or
 * observes it (one being removed included: its own deletion handles that copy),
 * a container on the server was created from it (it may have to be recreated
 * from it), or it is an undeleted version of an image still assigned here.
 */
function copyNeeded(
  expression: ExpressionBuilder<NyabaseDatabase & { copy: NyabaseDatabase['infra.image_copies'] }, 'copy'>,
  serverId: string,
) {
  const { exists, selectFrom, or } = expression;
  return or([
    exists(selectFrom('infra.images as i')
      .select('i.id')
      .whereRef('i.fingerprint', '=', 'copy.fingerprint')),
    exists(selectFrom('infra.image_server_assignments as a')
      .select('a.id')
      .where('a.server_id', '=', serverId)
      .where((inner) => inner.or([
        inner('a.managed_fingerprint', '=', inner.ref('copy.fingerprint')),
        inner('a.observed_fingerprint', '=', inner.ref('copy.fingerprint')),
      ]))),
    exists(selectFrom('control.containers as c')
      .select('c.id')
      .where('c.server_id', '=', serverId)
      .whereRef('c.image_fingerprint', '=', 'copy.fingerprint')),
    exists(selectFrom('infra.image_versions as kept')
      .innerJoin('infra.image_server_assignments as a', 'a.image_id', 'kept.image_id')
      .select('kept.image_id')
      .whereRef('kept.fingerprint', '=', 'copy.fingerprint')
      .where('kept.deleted_at', 'is', null)
      .where('a.server_id', '=', serverId)
      .where('a.lifecycle_phase', '!=', 'deleting')),
  ]);
}

/** Every SQL statement the image assignment reconciler issues. */
@Injectable()
export class ImageReconcileStore {
  constructor(@Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>) {}

  // --- ManagedReconciler state -------------------------------------------------

  async needsAttention(assignmentId: string): Promise<boolean> {
    const row = await this.database
      .selectFrom('infra.image_server_assignments')
      .select('needs_attention')
      .where('id', '=', assignmentId)
      .executeTakeFirst();
    return row?.needs_attention === true;
  }

  async markSucceeded(assignmentId: string): Promise<void> {
    await this.database
      .updateTable('infra.image_server_assignments')
      .set({
        needs_attention: false,
        failure_code: null,
        failure_reason: null,
        last_observed_at: sql<Date>`clock_timestamp()`,
      })
      .where('id', '=', assignmentId)
      .execute();
  }

  async markFailure(
    assignmentId: string,
    failure: IntentFailure,
    attention: boolean,
  ): Promise<void> {
    const values = {
      needs_attention: attention,
      failure_code: failure.code.slice(0, 128),
      failure_reason: failure.message.slice(0, 4096),
      last_observed_at: sql<Date>`clock_timestamp()`,
      ...(attention ? { lifecycle_phase: 'failed' as const } : {}),
    };
    await this.database
      .updateTable('infra.image_server_assignments')
      .set(values)
      .where('id', '=', assignmentId)
      .execute();
  }

  // --- full scan ---------------------------------------------------------------

  /** The server's assignments that have not given up (failed ones are left alone). */
  listScanAssignments(serverId: string): Promise<AssignmentRow[]> {
    return this.database
      .selectFrom('infra.image_server_assignments as a')
      .innerJoin('infra.images as i', 'i.id', 'a.image_id')
      .select([...ASSIGNMENT_COLUMNS])
      .where('a.server_id', '=', serverId)
      .where('a.lifecycle_phase', '!=', 'failed')
      .execute();
  }

  /** Inactive images waiting for their physical copies to be removed. */
  listImagesPendingCleanup() {
    return this.database
      .selectFrom('infra.images')
      .select(['id', 'fingerprint', 'cleanup_generation'])
      .where('is_active', '=', false)
      .where('deleting', '=', true)
      .execute();
  }

  /**
   * Images something in the database still holds: a server assignment (being
   * removed by its own intent), or a container row of any phase (a failed one,
   * or a delete that is stuck or parked).
   */
  async listHeldImageIds(): Promise<Set<string>> {
    const rows = await this.database
      .selectFrom('infra.image_server_assignments')
      .select('image_id')
      .union(this.database.selectFrom('control.containers').select('image_id'))
      .execute();
    return new Set(rows.map((row) => row.image_id));
  }

  /** One server (the lowest id) owns the cleanup of images no server holds any more. */
  async cleanupOwnerServerId(): Promise<string | undefined> {
    const owner = await this.database
      .selectFrom('infra.servers')
      .select('id')
      .orderBy('id')
      .executeTakeFirst();
    return owner?.id;
  }

  // --- ensure ------------------------------------------------------------------

  async readAssignment(id: string): Promise<AssignmentRow | undefined> {
    return this.database
      .selectFrom('infra.image_server_assignments as a')
      .innerJoin('infra.images as i', 'i.id', 'a.image_id')
      .select([...ASSIGNMENT_COLUMNS])
      .where('a.id', '=', id)
      .executeTakeFirst();
  }

  /** The assignment now holds the fingerprint; the image's desired fingerprint follows. */
  async recordEnsured(assignment: AssignmentRow, fingerprint: string): Promise<void> {
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
    // Only an image added without a fingerprint learns it here. A pinned image
    // keeps its own: an ensure that finishes after a repull must not undo it.
    const learned = await this.database
      .updateTable('infra.images')
      .set({ fingerprint })
      .where('id', '=', assignment.image_id)
      .where('fingerprint', 'is', null)
      .returning(['id', 'description'])
      .executeTakeFirst();
    // A late ensure of a deleted version leaves it deleted (no conflict update).
    await this.database
      .insertInto('infra.image_versions')
      .values({
        image_id: assignment.image_id,
        fingerprint,
        description: learned ? learned.description : null,
      })
      .onConflict((conflict) => conflict.columns(['image_id', 'fingerprint']).doNothing())
      .execute();
    await this.database
      .insertInto('infra.image_copies')
      .values({ server_id: assignment.server_id, fingerprint })
      .onConflict((conflict) => conflict.columns(['server_id', 'fingerprint'])
        .doUpdateSet({ recorded_at: sql<Date>`clock_timestamp()` }))
      .execute();
  }

  // --- image copies ------------------------------------------------------------

  /**
   * Forget copies that are gone from the server. A copy recorded in the last few
   * minutes is left alone: its pull may have finished after the scan listed the
   * server (every ensure refreshes `recorded_at`).
   */
  async forgetMissingCopies(serverId: string, present: readonly string[]): Promise<void> {
    let query = this.database
      .deleteFrom('infra.image_copies')
      .where('server_id', '=', serverId)
      .where('recorded_at', '<', sql<Date>`clock_timestamp() - interval '5 minutes'`);
    if (present.length > 0) query = query.where('fingerprint', 'not in', [...present]);
    await query.execute();
  }

  /**
   * Of the copies nyabase recorded on the server and that are present there,
   * the ones nothing needs any more (see `copyNeeded`). Copies nyabase never
   * recorded on this server, such as the host owner's own images, are never listed.
   */
  async listUnneededCopies(
    serverId: string,
    present: readonly string[],
    keep: readonly string[],
  ): Promise<string[]> {
    if (present.length === 0) return [];
    let query = this.database
      .selectFrom('infra.image_copies as copy')
      .select('copy.fingerprint')
      .where('copy.server_id', '=', serverId)
      .where('copy.fingerprint', 'in', [...present])
      .where((expression) => expression.not(copyNeeded(expression, serverId)));
    if (keep.length > 0) query = query.where('copy.fingerprint', 'not in', [...keep]);
    return (await query.execute()).map((row) => row.fingerprint);
  }

  /**
   * Delete one copy if it is still unneeded, rechecked right before the Incus
   * call (no transaction is held across it). A repull back to this fingerprint
   * landing in that instant finds the copy gone and the next scan's ensure
   * pulls it again. Returns the image id to audit against, or null when kept.
   */
  async removeCopyIfUnneeded(
    serverId: string,
    fingerprint: string,
    remove: () => Promise<void>,
  ): Promise<{ imageId: string | null } | null> {
    const unneeded = await this.database
      .selectFrom('infra.image_copies as copy')
      .select('copy.fingerprint')
      .where('copy.server_id', '=', serverId)
      .where('copy.fingerprint', '=', fingerprint)
      .where((expression) => expression.not(copyNeeded(expression, serverId)))
      .executeTakeFirst();
    if (!unneeded) return null;
    await remove();
    await this.forgetCopy(serverId, fingerprint);
    const version = await this.database
      .selectFrom('infra.image_versions')
      .select('image_id')
      .where('fingerprint', '=', fingerprint)
      .orderBy('image_id')
      .executeTakeFirst();
    return { imageId: version?.image_id ?? null };
  }

  /** The copy is gone from the server. */
  async forgetCopy(serverId: string, fingerprint: string): Promise<void> {
    await this.database
      .deleteFrom('infra.image_copies')
      .where('server_id', '=', serverId)
      .where('fingerprint', '=', fingerprint)
      .execute();
  }

  // --- image cleanup -----------------------------------------------------------

  async readImage(id: string): Promise<ImageCleanupRow | undefined> {
    return this.database
      .selectFrom('infra.images')
      .select(['id', 'fingerprint', 'is_active', 'deleting', 'cleanup_generation'])
      .where('id', '=', id)
      .executeTakeFirst();
  }

  listAssignmentIdsOfImage(imageId: string) {
    return this.database
      .selectFrom('infra.image_server_assignments')
      .select('id')
      .where('image_id', '=', imageId)
      .execute();
  }

  findContainerOfImage(imageId: string) {
    return this.database
      .selectFrom('control.containers')
      .select('id')
      .where('image_id', '=', imageId)
      .executeTakeFirst();
  }

  async deleteInactiveImage(imageId: string): Promise<void> {
    await this.database
      .deleteFrom('infra.images')
      .where('id', '=', imageId)
      .where('is_active', '=', false)
      .where('deleting', '=', true)
      .execute();
  }

  // --- assignment deletion -----------------------------------------------------

  /** Another live assignment on the server that holds the same fingerprint. */
  findOtherAssignmentHolding(assignment: AssignmentRow, fingerprint: string) {
    return this.database
      .selectFrom('infra.image_server_assignments')
      .select('id')
      .where('server_id', '=', assignment.server_id)
      .where('id', '!=', assignment.id)
      .where('lifecycle_phase', '!=', 'deleting')
      .where((expression) => expression.or([
        expression('managed_fingerprint', '=', fingerprint),
        expression('observed_fingerprint', '=', fingerprint),
      ]))
      .executeTakeFirst();
  }

  findContainerPinnedTo(serverId: string, fingerprint: string) {
    return this.database
      .selectFrom('control.containers')
      .select('id')
      .where('server_id', '=', serverId)
      .where('image_fingerprint', '=', fingerprint)
      .where('lifecycle_phase', '!=', 'deleting')
      .executeTakeFirst();
  }

  async bumpCleanupGeneration(imageId: string): Promise<void> {
    await this.database
      .updateTable('infra.images')
      .set({ cleanup_generation: sql<number>`cleanup_generation + 1` })
      .where('id', '=', imageId)
      .execute();
  }

  /**
   * Drop the assignment. When the physical image is gone too and nothing else
   * references an inactive image, the image row goes with it.
   */
  async markAssignmentDeleted(assignment: AssignmentRow, physicalGone: boolean): Promise<void> {
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
    if (await this.findContainerOfImage(assignment.image_id)) return;
    await this.deleteInactiveImage(assignment.image_id);
  }
}
