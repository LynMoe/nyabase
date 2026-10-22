import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';

/** Inserts the minimal infra.servers row intents and leases can point at. */
export async function insertServerFixture(
  database: Kysely<NyabaseDatabase>,
  name = `fixture-${randomUUID().slice(0, 8)}`,
): Promise<string> {
  const id = randomUUID();
  await database.insertInto('infra.servers').values({
    id,
    name,
    slug: name,
    parent_interface: null,
    dns_servers: [],
    status: 'unknown',
    api_extensions: [],
    storage_overcommit_ratio: 1,
    system_pool_id: null,
    incus_version: null,
    last_seen_at: null,
    last_error: null,
    revision: 1,
    node_metrics_status: 'unknown',
    node_metrics_last_success_at: null,
    node_metrics_outage_since: null,
    node_metrics_last_error: null,
    preflight_status: 'not_run',
    preflight_checked_at: null,
    preflight_report: null,
  }).execute();
  return id;
}
