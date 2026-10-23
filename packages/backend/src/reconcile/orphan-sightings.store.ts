import { sql, type Kysely } from 'kysely';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';

/** How long an orphan stays quarantined (instance stopped, nothing deleted) before it is removed. */
export const ORPHAN_QUARANTINE_MS = 7 * 24 * 60 * 60_000;

export type OrphanKind = 'instance' | 'volume';

/** An instance (`poolName` empty) or a custom volume in `poolName`. */
export interface OrphanRef {
  readonly poolName: string;
  readonly name: string;
}

export interface OrphanSightingResult {
  /** Seen by this scan for the first time. */
  readonly fresh: OrphanRef[];
  /** Quarantined for at least the quarantine period: may now be deleted. */
  readonly due: OrphanRef[];
}

function key(ref: OrphanRef): string {
  return `${ref.poolName}\u0000${ref.name}`;
}

/**
 * SQL of the orphan quarantine ledger (`control.orphan_sightings`), shared by
 * the container and volume reconcile stores. The full scan reports every
 * orphan of one kind it saw on a server; the ledger keeps the first sighting,
 * forgets the ones it no longer sees, and names those whose quarantine is over.
 */
export class OrphanSightingsStore {
  constructor(private readonly database: Kysely<NyabaseDatabase>) {}

  async sight(
    serverId: string,
    kind: OrphanKind,
    orphans: readonly OrphanRef[],
    quarantineMs: number = ORPHAN_QUARANTINE_MS,
  ): Promise<OrphanSightingResult> {
    const seen = new Set(orphans.map(key));
    const existing = await this.database.selectFrom('control.orphan_sightings')
      .select(['pool_name', 'name'])
      .where('server_id', '=', serverId)
      .where('kind', '=', kind)
      .execute();
    for (const row of existing) {
      if (seen.has(key({ poolName: row.pool_name, name: row.name }))) continue;
      await this.forget(serverId, kind, { poolName: row.pool_name, name: row.name });
    }
    if (orphans.length === 0) return { fresh: [], due: [] };
    const inserted = await this.database.insertInto('control.orphan_sightings')
      .values(orphans.map((orphan) => ({
        server_id: serverId,
        kind,
        pool_name: orphan.poolName,
        name: orphan.name,
      })))
      .onConflict((conflict) => conflict.columns(['server_id', 'kind', 'pool_name', 'name']).doNothing())
      .returning(['pool_name', 'name'])
      .execute();
    const due = await this.database.selectFrom('control.orphan_sightings')
      .select(['pool_name', 'name'])
      .where('server_id', '=', serverId)
      .where('kind', '=', kind)
      .where('first_seen_at', '<=', sql<Date>`clock_timestamp() - make_interval(secs => ${quarantineMs / 1000})`)
      .execute();
    return {
      fresh: inserted.map((row) => ({ poolName: row.pool_name, name: row.name })),
      due: due
        .map((row) => ({ poolName: row.pool_name, name: row.name }))
        .filter((ref) => seen.has(key(ref))),
    };
  }

  async forget(serverId: string, kind: OrphanKind, orphan: OrphanRef): Promise<void> {
    await this.database.deleteFrom('control.orphan_sightings')
      .where('server_id', '=', serverId)
      .where('kind', '=', kind)
      .where('pool_name', '=', orphan.poolName)
      .where('name', '=', orphan.name)
      .execute();
  }
}
