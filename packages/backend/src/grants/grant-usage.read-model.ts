import { sql, type Kysely } from 'kysely';
import { ContainerPhase, ContainerPowerIntent } from '@nyabase/common';
import { numberValue } from '../platform/domain-utils.js';
import { committedRootBytesSql } from '../platform/persistence-pg/committed-bytes.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';

/**
 * What the users of one server hold, counted as admission counts it, so a
 * bundle preview can tell which grants a smaller quota no longer covers.
 * Read-only queries over containers (owned by the containers module).
 */
export interface ServerUsageByUser {
  /** Memory of containers whose power intent is running (failed ones too), by owner. */
  runningMemBytes: Map<string, number>;
  /** Committed system-disk bytes of live containers, by owner. */
  rootDiskBytes: Map<string, number>;
  /** GPU cards the owner's containers hold, by owner. */
  gpuClaims: Map<string, string[]>;
  /** Data on the owner's live volumes of the server's local pools: owner → pool → bytes (unknown usage counts 0). */
  dataBytes: Map<string, Map<string, number>>;
}

export async function loadServerUsageByUser(
  database: Kysely<NyabaseDatabase>,
  serverId: string,
  userIds: readonly string[],
): Promise<ServerUsageByUser> {
  if (userIds.length === 0) {
    return { runningMemBytes: new Map(), rootDiskBytes: new Map(), gpuClaims: new Map(), dataBytes: new Map() };
  }
  const [memory, roots, claims, volumes] = await Promise.all([
    database.selectFrom('control.containers')
      .select(['owner_id', sql<string>`coalesce(sum(mem_bytes), 0)`.as('bytes')])
      .where('server_id', '=', serverId)
      .where('owner_id', 'in', userIds)
      .where('power_intent', '=', ContainerPowerIntent.Running)
      .where('lifecycle_phase', '<>', ContainerPhase.Deleting)
      .groupBy('owner_id')
      .execute(),
    database.selectFrom('control.containers')
      .select(['owner_id', sql<string>`coalesce(sum(${committedRootBytesSql()}), 0)`.as('bytes')])
      .where('server_id', '=', serverId)
      .where('owner_id', 'in', userIds)
      .where('lifecycle_phase', 'not in', ['failed', 'deleting'])
      .groupBy('owner_id')
      .execute(),
    database.selectFrom('control.container_gpu_claims as claim')
      .innerJoin('control.containers as container', 'container.id', 'claim.container_id')
      .select(['container.owner_id', 'claim.pci_address'])
      .where('claim.server_id', '=', serverId)
      .where('container.owner_id', 'in', userIds)
      .distinct()
      .orderBy('claim.pci_address')
      .execute(),
    database.selectFrom('control.volumes')
      .select(['owner_id', 'pool_id', sql<string>`coalesce(sum(coalesce(used_bytes, 0)), 0)`.as('bytes')])
      .where('server_id', '=', serverId)
      .where('owner_id', 'in', userIds)
      .where('pool_id', 'is not', null)
      .where('shared_backend_id', 'is', null)
      .where('lifecycle_phase', 'not in', ['failed', 'deleting'])
      .groupBy(['owner_id', 'pool_id'])
      .execute(),
  ]);
  const dataBytes = new Map<string, Map<string, number>>();
  for (const row of volumes) {
    const byPool = dataBytes.get(row.owner_id) ?? new Map<string, number>();
    byPool.set(row.pool_id!, numberValue(row.bytes));
    dataBytes.set(row.owner_id, byPool);
  }
  const gpuClaims = new Map<string, string[]>();
  for (const claim of claims) {
    const list = gpuClaims.get(claim.owner_id) ?? [];
    list.push(claim.pci_address);
    gpuClaims.set(claim.owner_id, list);
  }
  return {
    runningMemBytes: new Map(memory.map((row) => [row.owner_id, numberValue(row.bytes)])),
    rootDiskBytes: new Map(roots.map((row) => [row.owner_id, numberValue(row.bytes)])),
    gpuClaims,
    dataBytes,
  };
}
