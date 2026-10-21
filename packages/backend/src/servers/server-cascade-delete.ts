import { AuditAction } from '@nyabase/common';
import { sql, type Transaction } from 'kysely';
import type { AuditService } from '../iam/audit.service.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { VOLUME_DESTROY_PLACEMENT_ID } from '../reconcile/reconcile-claim.repository.js';
import { listEligibleDestroyExecutors } from '../volumes/volumes.repository.js';

type Tx = Transaction<NyabaseDatabase>;

/** Drop the server's claims, intents, containers and their volume attachments. */
async function purgeContainers(transaction: Tx, serverId: string): Promise<Set<string>> {
  await transaction
    .deleteFrom('control.reconcile_claims')
    .where((expression) => expression.or([
      expression('server_id', '=', serverId),
      expression('placement_server_id', '=', serverId),
    ]))
    .execute();
  await transaction.deleteFrom('control.intents').where('server_id', '=', serverId).execute();
  const attachmentsOnS = await transaction
    .selectFrom('control.volume_attachments')
    .select('volume_id')
    .where('container_id', 'in', transaction
      .selectFrom('control.containers')
      .select('id')
      .where('server_id', '=', serverId))
    .execute();
  const volumeIdsLostAttachment = new Set(attachmentsOnS.map((row) => row.volume_id));
  await transaction
    .deleteFrom('control.volume_attachments')
    .where('container_id', 'in', transaction
      .selectFrom('control.containers')
      .select('id')
      .where('server_id', '=', serverId))
    .execute();
  await transaction.deleteFrom('control.containers').where('server_id', '=', serverId).execute();
  return volumeIdsLostAttachment;
}

/** Local volumes live on one server and go with it. */
async function purgeLocalVolumes(transaction: Tx, serverId: string): Promise<void> {
  const localVolumes = await transaction
    .selectFrom('control.volumes')
    .select('id')
    .where('server_id', '=', serverId)
    .execute();
  for (const volume of localVolumes) {
    await transaction.deleteFrom('control.volume_placements').where('volume_id', '=', volume.id).execute();
    await transaction.deleteFrom('control.volumes').where('id', '=', volume.id).execute();
  }
}

/** Remove the server's placements of shared volumes; returns the volumes that lost one. */
async function dropSharedPlacements(transaction: Tx, serverId: string): Promise<Set<string>> {
  const placementsOnS = await transaction
    .selectFrom('control.volume_placements as pl')
    .innerJoin('control.volumes as v', 'v.id', 'pl.volume_id')
    .select('pl.volume_id as volume_id')
    .where('pl.server_id', '=', serverId)
    .where('v.shared_backend_id', 'is not', null)
    .execute();
  const volumeIdsLostPlacement = new Set(placementsOnS.map((row) => row.volume_id));
  await transaction.deleteFrom('control.volume_placements').where('server_id', '=', serverId).execute();
  return volumeIdsLostPlacement;
}

/**
 * Shared volumes with no placement left: when this server was the last way to
 * reach them, drop their tracking (and any pending destroy) with the server.
 */
async function dropEmptiedSharedVolumes(
  transaction: Tx,
  audit: AuditService,
  serverId: string,
  volumeIdsLostPlacement: ReadonlySet<string>,
  volumeIdsLostAttachment: ReadonlySet<string>,
): Promise<void> {
  const emptyShared = await transaction
    .selectFrom('control.volumes')
    .select(['id', 'shared_backend_id', 'server_id', 'pool_id', 'dir_ensured'])
    .where('server_id', 'is', null)
    .where('shared_backend_id', 'is not', null)
    .execute();
  for (const volume of emptyShared) {
    const attachment = await transaction
      .selectFrom('control.volume_attachments')
      .select('id')
      .where('volume_id', '=', volume.id)
      .executeTakeFirst();
    const placement = await transaction
      .selectFrom('control.volume_placements')
      .select('server_id')
      .where('volume_id', '=', volume.id)
      .executeTakeFirst();
    const eligible = volume.shared_backend_id
      ? await listEligibleDestroyExecutors(transaction, volume.shared_backend_id, {
        excludeServerId: serverId,
      })
      : [];
    const claimed = await transaction
      .selectFrom('control.reconcile_claims')
      .select('resource_id')
      .where('resource_type', '=', 'volume')
      .where('resource_id', '=', volume.id)
      .where('placement_server_id', '=', VOLUME_DESTROY_PLACEMENT_ID)
      .where('lease_expires_at', '>', sql<Date>`clock_timestamp()`)
      .executeTakeFirst();
    const sWasEligible = volume.shared_backend_id
      ? Boolean(await transaction
        .selectFrom('infra.storage_pools')
        .select('id')
        .where('server_id', '=', serverId)
        .where('shared_backend_id', '=', volume.shared_backend_id)
        .where('driver', '=', 'cephfs')
        .where('shareable', '=', true)
        .where('registered', '=', true)
        .executeTakeFirst())
      : false;
    const touchedByS = volumeIdsLostPlacement.has(volume.id)
      || volumeIdsLostAttachment.has(volume.id);
    const executorGone = eligible.length === 0 && sWasEligible;
    if (!touchedByS && !(executorGone && (claimed || volume.dir_ensured))) continue;
    if (attachment) continue;
    if (placement && eligible.length > 0) continue;
    if (claimed && eligible.length > 0) continue;
    const reason = claimed && eligible.length === 0
      ? 'destroy_executor_gone'
      : 'server_cascade_empty_tracking';
    if (volume.shared_backend_id) {
      await transaction
        .selectFrom('infra.shared_backends')
        .select('id')
        .where('id', '=', volume.shared_backend_id)
        .forUpdate()
        .execute();
    }
    await transaction
      .deleteFrom('control.reconcile_claims')
      .where('resource_type', '=', 'volume')
      .where('resource_id', '=', volume.id)
      .execute();
    await transaction
      .deleteFrom('control.intents')
      .where('resource_type', '=', 'volume')
      .where('resource_id', '=', volume.id)
      .execute();
    await transaction.deleteFrom('control.volume_placements').where('volume_id', '=', volume.id).execute();
    await transaction.deleteFrom('control.volumes').where('id', '=', volume.id).execute();
    await audit.append(transaction, null, AuditAction.DeleteVolume, volume.id, 'volume', {
      reason,
    });
  }
}

/** Grants, lapses, assignments, addresses, pools and finally the server row. */
async function purgeGrantsAndInventory(transaction: Tx, serverId: string): Promise<void> {
  await transaction
    .deleteFrom('control.access_lapses')
    .where((expression) => expression.or([
      expression.and([
        expression('resource_kind', '=', 'server'),
        expression('resource_id', '=', serverId),
      ]),
      expression.and([
        expression('resource_kind', '=', 'storage_pool'),
        expression('resource_id', 'in', transaction
          .selectFrom('infra.storage_pools')
          .select('id')
          .where('server_id', '=', serverId)),
      ]),
    ]))
    .execute();
  await transaction.deleteFrom('iam.server_grants').where('server_id', '=', serverId).execute();
  await transaction
    .deleteFrom('iam.storage_pool_grants')
    .where('pool_id', 'in', transaction
      .selectFrom('infra.storage_pools')
      .select('id')
      .where('server_id', '=', serverId))
    .execute();
  await transaction.deleteFrom('infra.image_server_assignments').where('server_id', '=', serverId).execute();
  await transaction.deleteFrom('control.container_network_claims').where('server_id', '=', serverId).execute();
  await transaction.deleteFrom('infra.ip_pool_servers').where('server_id', '=', serverId).execute();
  await transaction
    .updateTable('infra.servers')
    .set({ system_pool_id: null })
    .where('id', '=', serverId)
    .execute();
  await transaction.deleteFrom('infra.storage_pools').where('server_id', '=', serverId).execute();
  await transaction.deleteFrom('infra.servers').where('id', '=', serverId).execute();
}

/** Remove every control-plane row that depends on a server, in dependency order. */
export async function purgeServerControlPlane(
  transaction: Tx,
  audit: AuditService,
  serverId: string,
): Promise<void> {
  const volumeIdsLostAttachment = await purgeContainers(transaction, serverId);
  await purgeLocalVolumes(transaction, serverId);
  const volumeIdsLostPlacement = await dropSharedPlacements(transaction, serverId);
  await dropEmptiedSharedVolumes(
    transaction,
    audit,
    serverId,
    volumeIdsLostPlacement,
    volumeIdsLostAttachment,
  );
  await purgeGrantsAndInventory(transaction, serverId);
}
