import {
  ContainerPhase,
  ContainerStatus,
  ServerStatus,
  type ContainerDto,
  type EffectiveServerAccessDto,
  type GraceServerAccessDto,
  type LiveServerAccessDto,
  type PerformanceServerUsage,
  type UserServerDto,
} from '@nyabase/common';
import { freeGpuCount, grantedGpuCards, type GrantedGpuCard } from './gpu-occupancy.js';

/** The containers a server card lists before linking to the container page. */
export const DASHBOARD_CONTAINER_LIMIT = 3;

/**
 * Sample age past which a card says how old its data is. The server's
 * `stale` flag trips at 45 s, which ordinary query lag already approaches.
 */
export const DASHBOARD_STALE_HINT_MS = 120_000;

/** Grant expiry close enough to show on the card. */
export const DASHBOARD_EXPIRY_SOON_MS = 14 * 86_400_000;

/** One card of the 概览 page: a server the user is granted, in grace on, or has containers on. */
export interface DashboardServer {
  serverId: string;
  name: string;
  online: boolean;
  gpuEnabled: boolean;
  access: LiveServerAccessDto | null;
  grace: GraceServerAccessDto | null;
  usage: PerformanceServerUsage | null;
  /** The granted cards; empty without GPU access. */
  gpus: GrantedGpuCard[];
  containers: ContainerDto[];
}

export function dashboardServers(input: {
  servers: readonly UserServerDto[];
  access: readonly EffectiveServerAccessDto[];
  usage: readonly PerformanceServerUsage[];
  containers: readonly ContainerDto[];
  selfId: string | null;
}): DashboardServer[] {
  const server = new Map(input.servers.map((item) => [item.id, item]));
  const usage = new Map(input.usage.map((item) => [item.serverId, item]));
  const ids = new Set<string>([
    ...input.access.map((item) => item.serverId),
    ...input.containers.map((item) => item.serverId),
  ]);
  const cards = [...ids].map((serverId): DashboardServer => {
    const row = server.get(serverId);
    const access = input.access.find((item) => item.serverId === serverId);
    const live = access?.accessPhase === 'live' ? access : null;
    const online = row?.status === ServerStatus.Online;
    const snapshot = usage.get(serverId) ?? null;
    const containers = input.containers.filter((item) => item.serverId === serverId).sort(byRunningThenName);
    return {
      serverId,
      name: row?.name ?? containers[0]?.serverName ?? serverId,
      online,
      gpuEnabled: row?.gpuEnabled ?? false,
      access: live,
      grace: access?.accessPhase === 'grace' ? access : null,
      usage: snapshot,
      gpus: live ? grantedGpuCards(live.gpuPciAddresses, online ? snapshot?.host.gpus ?? null : null, input.selfId) : [],
      containers,
    };
  });
  return cards.sort((left, right) => rank(left) - rank(right)
    || left.name.localeCompare(right.name, 'zh-CN', { numeric: true }));
}

/** Free granted cards on the servers that are online. */
export function dashboardFreeGpus(servers: readonly DashboardServer[]): number {
  return servers.reduce((sum, server) => sum + (server.online ? freeGpuCount(server.gpus) : 0), 0);
}

/** Granted, online first; then granted but offline; then containers without a grant; grace last. */
function rank(server: DashboardServer): number {
  if (server.access) return server.online ? 0 : 1;
  return server.grace ? 3 : 2;
}

function byRunningThenName(left: ContainerDto, right: ContainerDto): number {
  return Number(right.actual.status === ContainerStatus.Running) - Number(left.actual.status === ContainerStatus.Running)
    || left.name.localeCompare(right.name, 'zh-CN', { numeric: true });
}

/** How a container reads in a card's list: lifecycle first, then the observed state. */
export function containerTone(container: ContainerDto): 'running' | 'attention' | 'pending' | 'idle' {
  if (container.needsAttention) return 'attention';
  if (container.lifecyclePhase !== ContainerPhase.Active) return 'pending';
  return container.actual.status === ContainerStatus.Running ? 'running' : 'idle';
}
