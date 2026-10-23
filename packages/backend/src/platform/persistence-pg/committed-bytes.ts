import { sql, type RawBuilder } from 'kysely';

/*
 * The bytes a row commits against grants and pool / backend capacity, for sums
 * over `control.volumes` and `control.containers`. A shrink counts at the
 * larger size it reserved until the reconciler verified it (migration 000002),
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
