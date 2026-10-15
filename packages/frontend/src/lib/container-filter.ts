import type { ContainerDto } from '@nyabase/common';
import { matchesSearch } from '../components/layout/list-search.js';

export type ContainerStatusFilter = 'all' | 'running' | 'stopped' | 'attention';

export function containerMatchesStatus(container: ContainerDto, filter: ContainerStatusFilter): boolean {
  switch (filter) {
    case 'running': return container.actual.status === 'running';
    case 'stopped': return container.actual.status !== 'running';
    case 'attention': return container.needsAttention;
    default: return true;
  }
}

export function filterContainers(
  containers: readonly ContainerDto[],
  query: string,
  status: ContainerStatusFilter,
): ContainerDto[] {
  return containers.filter((container) => containerMatchesStatus(container, status) && matchesSearch(query, [
    container.name,
    container.serverName,
    container.routedIp,
    container.ownerName,
    container.imageName,
  ]));
}

export function containerStatusOptions(containers: readonly ContainerDto[]) {
  const count = (filter: ContainerStatusFilter) => containers.filter((container) => containerMatchesStatus(container, filter)).length;
  const options: Array<{ value: ContainerStatusFilter; label: string; count: number }> = [
    { value: 'all', label: '全部', count: containers.length },
    { value: 'running', label: '运行中', count: count('running') },
    { value: 'stopped', label: '未运行', count: count('stopped') },
  ];
  const attention = count('attention');
  if (attention > 0) options.push({ value: 'attention', label: '需要处理', count: attention });
  return options;
}
