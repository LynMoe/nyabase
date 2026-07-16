import {
  MAX_ACTIVE_RUNTIME_CLEANUP_CLAIMS_PER_SERVER,
  MAX_AGENT_MACVLAN_RESERVED_IPS,
  MAX_MANAGED_CONTAINERS_PER_AGENT,
  MAX_PLATFORM_SERVERS,
} from '@nyabase/common';
import { In, LessThanOrEqual, type EntityManager } from 'typeorm';
import { NetworkAddressClaimEntity } from '../entities/network-address-claim.entity.js';
import {
  monotonicReuseGuard,
  networkClaimReuseKey,
  type MonotonicReuseGuard,
} from './monotonic-reuse-guard.js';

/**
 * One complete active ledger plus one equally sized drain window. New writes
 * stop at this bound until fixed-batch GC proves old proxy leases expired.
 */
export const MAX_NETWORK_ADDRESS_CLAIMS_GLOBAL = MAX_PLATFORM_SERVERS * (
  MAX_AGENT_MACVLAN_RESERVED_IPS
  + 1 // shared gateway; deliberately over-counted once per Server
  + MAX_MANAGED_CONTAINERS_PER_AGENT
  + MAX_ACTIVE_RUNTIME_CLEANUP_CLAIMS_PER_SERVER
) * 2;

export const NETWORK_CLAIM_GC_BATCH = 4_096;

export class NetworkClaimLedgerCapacityError extends Error {
  constructor(current: number, additional: number) {
    super(
      `Network address claim ledger capacity ${MAX_NETWORK_ADDRESS_CLAIMS_GLOBAL} would be exceeded `
      + `(current=${current}, additional=${additional})`,
    );
    this.name = 'NetworkClaimLedgerCapacityError';
  }
}

export async function assertNetworkClaimCapacity(
  manager: EntityManager,
  additional: number,
): Promise<void> {
  if (!Number.isSafeInteger(additional) || additional < 0) {
    throw new Error(`Invalid network claim capacity request: ${String(additional)}`);
  }
  const current = await manager.count(NetworkAddressClaimEntity);
  if (current > MAX_NETWORK_ADDRESS_CLAIMS_GLOBAL - additional) {
    throw new NetworkClaimLedgerCapacityError(current, additional);
  }
}

/**
 * Delete only rows whose durable wall lease and process-observed monotonic
 * lease both expired. The fixed batch makes every report/create bounded while
 * repeated reports guarantee progress on a long-lived Agent connection.
 */
export async function gcExpiredNetworkClaims(
  manager: EntityManager,
  options: {
    now?: Date;
    limit?: number;
    guard?: Pick<MonotonicReuseGuard, 'mayReuse'>;
  } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? NETWORK_CLAIM_GC_BATCH;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > NETWORK_CLAIM_GC_BATCH) {
    throw new Error(`Invalid network claim GC batch: ${String(limit)}`);
  }
  const guard = options.guard ?? monotonicReuseGuard;
  const expired = await manager.find(NetworkAddressClaimEntity, {
    where: { state: 'releasing', reusableAt: LessThanOrEqual(now) },
    order: { reusableAt: 'ASC', id: 'ASC' },
    take: limit,
  });
  const reusableIds = expired
    .filter((claim) => guard.mayReuse(
      networkClaimReuseKey(claim.id),
      claim.reusableAt,
      now.getTime(),
    ))
    .map((claim) => claim.id);
  if (reusableIds.length > 0) {
    await manager.delete(NetworkAddressClaimEntity, { id: In(reusableIds) });
  }
  return reusableIds.length;
}
