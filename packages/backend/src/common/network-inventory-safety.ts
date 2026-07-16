import { ServerStatus } from '@nyabase/common';
import { Not, type EntityManager } from 'typeorm';
import { ServerEntity } from '../entities/server.entity.js';

/**
 * A non-online peer on a shared macvlan has no current authoritative observer
 * and may hold runtime evidence which has not reached the address ledger. New
 * allocation and activation stop until every peer has completed inventory
 * recovery.
 */
export function networkHasUntrustedInventory(
  manager: EntityManager,
  networkKey: string,
): Promise<boolean> {
  return manager.existsBy(ServerEntity, {
    macvlanCidr: networkKey,
    status: Not(ServerStatus.Online),
  });
}
