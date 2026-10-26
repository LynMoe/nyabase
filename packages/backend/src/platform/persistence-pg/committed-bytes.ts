import { sql, type Kysely, type RawBuilder } from 'kysely';
import type { NyabaseDatabase } from './database.types.js';

/*
 * The bytes a row commits against grants and pool / backend capacity, for sums
 * over `control.volumes` and `control.containers`. A shrink counts at the
 * larger size it reserved until the reconciler verified it,
 * and a root quota Incus has not applied yet at its pending size. Columns are
 * unqualified: use them on a query over that one table.
 */

/** Committed bytes of one `control.volumes` row. */
export function committedVolumeBytesSql(): RawBuilder<string> {
  return sql<string>`greatest(size_bytes, coalesce(shrink_reserved_bytes, 0))`;
}

/** Committed root-disk bytes of one `control.containers` row. */
export function committedRootBytesSql(): RawBuilder<string> {
  return sql<string>`greatest(
    root_size_bytes,
    coalesce(root_size_pending_bytes, 0),
    coalesce(root_shrink_reserved_bytes, 0)
  )`;
}

/**
 * The one rule for when a volume's shrink reservation is still needed: some
 * placement may still hold a size above the desired one, because it has not
 * caught up with the volume's current revision. A placement's
 * `observed_revision` is the last revision it verified, or at which its
 * catalog was found missing: a catalog that does not exist holds nothing, and
 * a volume without placements (a shared volume never attached anywhere) holds
 * nothing at all. A shared placement whose catalog is not known present has
 * not caught up either while an attachment of a container on that server
 * exists: that container's pass may be creating the catalog at a size it read
 * before the shrink. Any bind state counts, as the pass that read the
 * attachment before a detach finishes before the detaching row goes. It
 * catches up once the created catalog is verified (`markCatalogPresent` drops
 * the observed revision, so a resize verifies it) or the attachments go.
 * Releases the reservation of every listed volume the rule no longer holds
 * for and returns their ids. Called at every transition that can make it
 * false: the resize admission, a placement verified, a resize settled, a
 * catalog found missing, a placement dropped and every full scan of a volume
 * still holding one (a settled detach). A revision accepted concurrently
 * keeps the reservation, as the rule compares against the row's current
 * revision.
 */
export async function releaseSettledShrinkReservations(
  executor: Kysely<NyabaseDatabase>,
  volumeIds: readonly string[],
): Promise<string[]> {
  if (volumeIds.length === 0) return [];
  const rows = await executor
    .updateTable('control.volumes as v')
    .set({ shrink_reserved_bytes: null })
    .where('v.id', 'in', [...new Set(volumeIds)])
    .where('v.shrink_reserved_bytes', 'is not', null)
    .where(({ exists, not, selectFrom }) => not(exists(
      selectFrom('control.volume_placements as pl')
        .select('pl.volume_id')
        .whereRef('pl.volume_id', '=', 'v.id')
        .where(sql<boolean>`(
          pl.observed_revision is distinct from v.revision
          or (
            v.shared_backend_id is not null
            and pl.catalog_state <> 'present'
            and exists (
              select 1
              from control.volume_attachments a
              join control.containers c on c.id = a.container_id
              where a.volume_id = v.id and c.server_id = pl.server_id
            )
          )
        )`),
    )))
    .returning('v.id')
    .execute();
  return rows.map((row) => row.id);
}
