import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import type { IntentFailure } from '../reconcile/intent.repository.js';
import { sameFingerprint } from './image-assignment-ops.js';

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
      .select(['id', 'cleanup_generation'])
      .where('is_active', '=', false)
      .where('deleting', '=', true)
      .execute();
  }

  async listAssignedImageIds(): Promise<Set<string>> {
    const rows = await this.database
      .selectFrom('infra.image_server_assignments')
      .select('image_id')
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

  /** A container on the server still pinned to an older fingerprint of this image. */
  async findLeftoverPinnedContainers(
    serverId: string,
    imageId: string,
    desiredFingerprint: string | null,
  ): Promise<string | null> {
    if (desiredFingerprint === null || desiredFingerprint === undefined) return null;
    const rows = await this.database
      .selectFrom('control.containers')
      .select('image_fingerprint')
      .where('server_id', '=', serverId)
      .where('image_id', '=', imageId)
      .where('lifecycle_phase', '!=', 'deleting')
      .where('image_fingerprint', 'is not', null)
      .execute();
    const leftover = rows.find((row) => (
      row.image_fingerprint
      && !sameFingerprint(row.image_fingerprint, desiredFingerprint)
    ));
    return leftover?.image_fingerprint ?? null;
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
    await this.database
      .updateTable('infra.images')
      .set({ fingerprint })
      .where('id', '=', assignment.image_id)
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
