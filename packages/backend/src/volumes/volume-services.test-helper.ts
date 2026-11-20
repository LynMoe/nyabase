import type { Kysely } from 'kysely';
import type { AuditService } from '../iam/audit.service.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import type { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import type { IntentRepository } from '../reconcile/intent.repository.js';
import type { StoragePoolsRepository } from '../storage-pools/storage-pools.repository.js';
import { VolumeAttachmentsService } from './volume-attachments.service.js';
import { VolumeDtoAssembler } from './volume-dtos.js';
import { VolumeProvisioner } from './volume-provisioner.service.js';
import type { VolumesRepository } from './volumes.repository.js';
import { VolumesService } from './volumes.service.js';

/**
 * Builds the volume services over the same collaborators: the read surface,
 * the attachments, and the provisioner that creates, mounts and sizes
 * volumes, so a test can drive a whole flow.
 */
export function makeVolumeServices(
  repository: VolumesRepository,
  pools: StoragePoolsRepository,
  transactions: PgTransactionManager,
  intents: IntentRepository,
  database: Kysely<NyabaseDatabase>,
  audit: AuditService,
) {
  const dtos = new VolumeDtoAssembler(database, repository, pools);
  const volumes = new VolumesService(database, repository, pools, dtos, transactions, intents, audit);
  const attachments = new VolumeAttachmentsService(repository, transactions, intents, database, audit, dtos);
  const provisioner = new VolumeProvisioner(database, transactions, intents, repository, pools, audit);
  return {
    volumes,
    attachments,
    provisioner,
    list: volumes.list.bind(volumes),
    get: volumes.get.bind(volumes),
    capacity: volumes.capacity.bind(volumes),
    listShared: volumes.listShared.bind(volumes),
    getShared: volumes.getShared.bind(volumes),
    delete: volumes.delete.bind(volumes),
  };
}
