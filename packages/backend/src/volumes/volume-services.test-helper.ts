import { LocalVolumesService } from './local-volumes.service.js';
import { SharedVolumesService } from './shared-volumes.service.js';
import { VolumeAttachmentsService } from './volume-attachments.service.js';

type LocalArgs = ConstructorParameters<typeof LocalVolumesService>;
type SharedArgs = ConstructorParameters<typeof SharedVolumesService>;

/**
 * Builds the three volume services over the same collaborators and exposes
 * their methods on one object, so a test can drive a whole volume flow
 * (create, attach, resize, delete) without wiring each service by hand.
 */
export function makeVolumeServices(
  repository: LocalArgs[0],
  pools: LocalArgs[1],
  transactions: LocalArgs[2],
  intents: LocalArgs[3],
  database: LocalArgs[4],
  audit: LocalArgs[5],
  clients: SharedArgs[6],
) {
  const local = new LocalVolumesService(repository, pools, transactions, intents, database, audit);
  const shared = new SharedVolumesService(
    repository,
    pools,
    transactions,
    intents,
    database,
    audit,
    clients,
  );
  const attachments = new VolumeAttachmentsService(
    repository,
    pools,
    transactions,
    intents,
    database,
    audit,
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
