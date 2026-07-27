import {
  MAX_ACTIVE_RUNTIME_CLEANUP_CLAIMS_PER_SERVER,
  MAX_AGENT_MACVLAN_RESERVED_IPS,
  MAX_MANAGED_CONTAINERS_PER_AGENT,
  MAX_PLATFORM_SERVERS,
} from '@nyabase/common';

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
