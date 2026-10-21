import type { Kysely } from 'kysely';
import type { AuditService } from '../iam/audit.service.js';
import type { IncusClientFactory } from '../incus/incus-client.factory.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import type { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import type { IntentRepository } from '../reconcile/intent.repository.js';
import type { StoragePoolsRepository } from '../storage-pools/storage-pools.repository.js';
import { LocalVolumesService } from './local-volumes.service.js';
import { SharedVolumeCatalogInspectService } from './shared-volume-catalog.service.js';
import { SharedVolumesService } from './shared-volumes.service.js';
import { VolumeAttachmentsService } from './volume-attachments.service.js';
import { VolumeCapacityService } from './volume-capacity.service.js';
import { VolumeDtoAssembler } from './volume-dtos.js';
import { VolumeLifecycleService } from './volume-lifecycle.service.js';
import type { VolumesRepository } from './volumes.repository.js';

/**
 * Builds the three volume services over the same collaborators and exposes
 * their methods on one object, so a test can drive a whole volume flow
 * (create, attach, resize, delete) without wiring each service by hand.
 */
export function makeVolumeServices(
  repository: VolumesRepository,
  pools: StoragePoolsRepository,
  transactions: PgTransactionManager,
  intents: IntentRepository,
  database: Kysely<NyabaseDatabase>,
  audit: AuditService,
  clients: IncusClientFactory,
) {
  const dtos = new VolumeDtoAssembler(database, repository, pools);
  const capacity = new VolumeCapacityService(database, repository, pools);
  const lifecycle = new VolumeLifecycleService(repository, intents, audit);
  const local = new LocalVolumesService(
    repository,
    pools,
    transactions,
    intents,
    audit,
    dtos,
    capacity,
    lifecycle,
  );
  const shared = new SharedVolumesService(
    repository,
    pools,
    transactions,
    audit,
    dtos,
    capacity,
    lifecycle,
    new SharedVolumeCatalogInspectService(repository, database, clients),
  );
  const attachments = new VolumeAttachmentsService(
    repository,
    pools,
    transactions,
    intents,
    database,
    audit,
    dtos,
  );
  return {
    local,
    shared,
    attachments,
    list: local.list.bind(local),
    get: local.get.bind(local),
    capacity: local.capacity.bind(local),
    create: local.create.bind(local),
    patch: local.patch.bind(local),
    delete: local.delete.bind(local),
    listShared: shared.list.bind(shared),
    getShared: shared.get.bind(shared),
    createShared: shared.create.bind(shared),
    patchShared: shared.patch.bind(shared),
    deleteShared: shared.delete.bind(shared),
    attach: attachments.attach.bind(attachments),
    detach: attachments.detach.bind(attachments),
  };
}
