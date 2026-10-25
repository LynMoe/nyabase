import { useQuery } from '@tanstack/react-query';
import {
  Role,
  type ListScope,
  type PerformanceAdminUsageResponse,
  type PerformanceUsageResponse,
} from '@nyabase/common';
import { api } from '../lib/api.js';
import type { ContainerLiveUsage } from '../lib/container-usage.js';
import { queryKeys } from '../lib/query-keys.js';
import { queryPollInterval } from '../lib/query-lifecycle.js';
import { scopedPath } from '../lib/scoped-paths.js';
import { useHasRole } from '../lib/use-role.js';

export type ContainerLiveUsageIndex = {
  byContainer: ReadonlyMap<string, ContainerLiveUsage>;
  /** Servers whose latest samples are older than the freshness window. */
  staleServers: ReadonlySet<string>;
};

const EMPTY: ContainerLiveUsageIndex = { byContainer: new Map(), staleServers: new Set() };

/**
 * Live per-container samples for a container list. The user list reads its
 * own rows from `/performance/usage`; the admin list reads every container
 * from `?scope=all`, which needs the operator role.
 */
export function useContainerLiveUsage(scope: ListScope): ContainerLiveUsageIndex {
  const canViewAll = useHasRole(Role.Operator);
  const query = useQuery({
    queryKey: queryKeys.performance.servers(scope),
    queryFn: () => api.get<PerformanceUsageResponse | PerformanceAdminUsageResponse>(scopedPath('/performance/usage', scope)),
    enabled: scope === 'mine' || canViewAll,
    refetchInterval: (state) => queryPollInterval(state.state, { activeIntervalMs: 15_000 }),
    select: indexUsage,
  });
  return query.data ?? EMPTY;
}

function indexUsage(response: PerformanceUsageResponse | PerformanceAdminUsageResponse): ContainerLiveUsageIndex {
  const byContainer = new Map<string, ContainerLiveUsage>();
  const staleServers = new Set<string>();
  for (const server of response.servers) {
    if (server.stale) staleServers.add(server.serverId);
    if ('containers' in server) {
      for (const row of server.containers) byContainer.set(row.containerId, row);
    }
  }
  if ('ownContainers' in response) {
    for (const row of response.ownContainers ?? []) byContainer.set(row.containerId, row);
  }
  return { byContainer, staleServers };
}
