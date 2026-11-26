import { canonicalPciAddress, type ContainerDto } from '@nyabase/common';

/** How the 全平台容器 list folds its rows: per server, per owner, or one flat table. */
export type ContainerGrouping = 'server' | 'owner' | 'none';

export const DEFAULT_CONTAINER_GROUPING = 'server' satisfies ContainerGrouping;

export const CONTAINER_GROUPING_OPTIONS: ReadonlyArray<{ value: ContainerGrouping; label: string }> = [
  { value: 'server', label: '按服务器' },
  { value: 'owner', label: '按所有者' },
  { value: 'none', label: '不分组' },
];

/** Group key of the rows without an owner; ids are UUIDs, so it cannot collide. */
export const NO_OWNER_GROUP_KEY = '_';

export type ContainerGroup = {
  /** Server id, owner id ({@link NO_OWNER_GROUP_KEY} without one), or `all` for the flat list. */
  key: string;
  grouping: ContainerGrouping;
  containers: ContainerDto[];
};

export type ContainerGroupSummary = {
  total: number;
  running: number;
  stopped: number;
  attention: number;
  owners: number;
  servers: number;
  /** Distinct cards the group's containers are bound to (cards are shared between containers). */
  gpuCards: number;
};

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

function ownerKey(container: ContainerDto): string {
  return container.ownerId || NO_OWNER_GROUP_KEY;
}

function ownerSortName(container: ContainerDto): string {
  return container.ownerName ?? container.ownerDisplayName ?? '';
}

function byThenName(key: (container: ContainerDto) => string) {
  return (a: ContainerDto, b: ContainerDto) => collator.compare(key(a), key(b)) || collator.compare(a.name, b.name);
}

/**
 * Splits the list into groups. Server groups sort by server name and keep one
 * owner's containers together; owner groups sort by username (the ownerless
 * last) and keep one server's containers together. `none` is one group in the
 * order given.
 */
export function groupContainers(containers: readonly ContainerDto[], grouping: ContainerGrouping): ContainerGroup[] {
  if (grouping === 'none') return [{ key: 'all', grouping, containers: [...containers] }];
  const groupKey = grouping === 'server' ? (container: ContainerDto) => container.serverId : ownerKey;
  const buckets = new Map<string, ContainerDto[]>();
  for (const container of containers) {
    const key = groupKey(container);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(container);
    else buckets.set(key, [container]);
  }
  const rowOrder = grouping === 'server' ? byThenName(ownerSortName) : byThenName((container) => container.serverName);
  const groups = [...buckets.entries()].map(([key, rows]) => ({ key, grouping, containers: rows.sort(rowOrder) }));
  return groups.sort((a, b) => {
    const left = a.containers[0]!;
    const right = b.containers[0]!;
    if (grouping === 'server') return collator.compare(left.serverName, right.serverName);
    if ((a.key === NO_OWNER_GROUP_KEY) !== (b.key === NO_OWNER_GROUP_KEY)) return a.key === NO_OWNER_GROUP_KEY ? 1 : -1;
    return collator.compare(ownerSortName(left), ownerSortName(right));
  });
}

/**
 * The column a grouped table thins out: the owner inside a server group, the
 * server inside an owner group. Only the first row of a run names it.
 */
export function mergedColumn(grouping: ContainerGrouping): 'owner' | 'server' | null {
  if (grouping === 'server') return 'owner';
  if (grouping === 'owner') return 'server';
  return null;
}

export function repeatsPrevious(group: ContainerGroup, index: number): boolean {
  const column = mergedColumn(group.grouping);
  if (column === null || index === 0) return false;
  const key = column === 'owner' ? ownerKey : (container: ContainerDto) => container.serverId;
  return key(group.containers[index - 1]!) === key(group.containers[index]!);
}

export function summarizeContainerGroup(containers: readonly ContainerDto[]): ContainerGroupSummary {
  const owners = new Set<string>();
  const servers = new Set<string>();
  const cards = new Set<string>();
  let running = 0;
  let attention = 0;
  for (const container of containers) {
    if (container.ownerId) owners.add(container.ownerId);
    servers.add(container.serverId);
    if (container.actual.status === 'running') running += 1;
    if (container.needsAttention) attention += 1;
    for (const pci of container.gpu?.pciAddresses ?? []) {
      cards.add(`${container.serverId}/${canonicalPciAddress(pci) ?? pci}`);
    }
  }
  return {
    total: containers.length,
    running,
    stopped: containers.length - running,
    attention,
    owners: owners.size,
    servers: servers.size,
    gpuCards: cards.size,
  };
}

/** The `?group=&collapsed=` state of /manage/containers; the defaults stay out of the URL. */
export type ContainerListSearch = {
  group?: Exclude<ContainerGrouping, typeof DEFAULT_CONTAINER_GROUPING>;
  /** Comma-separated keys of the folded groups. */
  collapsed?: string;
};

const COLLAPSED_PATTERN = /^[A-Za-z0-9_-]+(,[A-Za-z0-9_-]+)*$/;

export function parseContainerListSearch(search: Record<string, unknown>): ContainerListSearch {
  const group = search.group === 'owner' || search.group === 'none' ? search.group : undefined;
  const collapsed = typeof search.collapsed === 'string'
    && search.collapsed.length <= 8_192
    && COLLAPSED_PATTERN.test(search.collapsed)
    ? search.collapsed
    : undefined;
  // Folding means nothing in the flat list.
  return { group, collapsed: group === 'none' ? undefined : collapsed };
}

export function collapsedKeys(search: ContainerListSearch): ReadonlySet<string> {
  return new Set(search.collapsed ? search.collapsed.split(',') : []);
}

export function serializeCollapsed(keys: Iterable<string>): string | undefined {
  const list = [...new Set(keys)].sort();
  return list.length > 0 ? list.join(',') : undefined;
}
