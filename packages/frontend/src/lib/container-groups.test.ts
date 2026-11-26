import { describe, expect, it } from 'vitest';
import type { ContainerDto } from '@nyabase/common';
import {
  collapsedKeys,
  groupContainers,
  NO_OWNER_GROUP_KEY,
  parseContainerListSearch,
  repeatsPrevious,
  serializeCollapsed,
  summarizeContainerGroup,
} from './container-groups.js';

function container(partial: Partial<ContainerDto> & { status?: string; cards?: string[] }): ContainerDto {
  return {
    id: partial.name, name: 'c', serverId: 's1', serverName: 'a800-1', ownerId: 'u1', ownerName: 'alice',
    needsAttention: false,
    ...partial,
    gpu: partial.cards ? { nvidiaRuntime: true, pciAddresses: partial.cards } : null,
    actual: { status: partial.status ?? 'running' },
  } as unknown as ContainerDto;
}

const rows = [
  container({ name: 'b-train', serverId: 's2', serverName: 'a800-10', ownerId: 'u2', ownerName: 'bob' }),
  container({ name: 'z-dev', serverId: 's1', serverName: 'a800-2', ownerId: 'u2', ownerName: 'bob' }),
  container({ name: 'a-dev', serverId: 's1', serverName: 'a800-2', ownerId: 'u1', ownerName: 'alice' }),
  container({ name: 'y-dev', serverId: 's1', serverName: 'a800-2', ownerId: 'u2', ownerName: 'bob', status: 'stopped' }),
  container({ name: 'orphan', serverId: 's2', serverName: 'a800-10', ownerId: '', ownerName: undefined }),
];

const names = (group: { containers: ContainerDto[] }) => group.containers.map((row) => row.name);

describe('container grouping', () => {
  it('orders servers by name with numbers compared as numbers, one owner run per server', () => {
    const groups = groupContainers(rows, 'server');
    expect(groups.map((group) => group.key)).toEqual(['s1', 's2']);
    expect(names(groups[0]!)).toEqual(['a-dev', 'y-dev', 'z-dev']);
    expect([0, 1, 2].map((index) => repeatsPrevious(groups[0]!, index))).toEqual([false, false, true]);
  });

  it('orders owners by username, the ownerless last, one server run per owner', () => {
    const groups = groupContainers(rows, 'owner');
    expect(groups.map((group) => group.key)).toEqual(['u1', 'u2', NO_OWNER_GROUP_KEY]);
    expect(names(groups[1]!)).toEqual(['y-dev', 'z-dev', 'b-train']);
    expect([0, 1, 2].map((index) => repeatsPrevious(groups[1]!, index))).toEqual([false, true, false]);
  });

  it('keeps the flat list as given and never blanks a cell in it', () => {
    const [flat] = groupContainers(rows, 'none');
    expect(names(flat!)).toEqual(rows.map((row) => row.name));
    expect(repeatsPrevious(flat!, 1)).toBe(false);
  });

  it('counts distinct cards per server, since cards are shared between containers', () => {
    const summary = summarizeContainerGroup([
      container({ name: 'a', cards: ['0000:4f:00.0', '0000:52:00.0'] }),
      container({ name: 'b', cards: ['00000000:4f:00.0'], status: 'stopped', needsAttention: true }),
      container({ name: 'c', serverId: 's2', ownerId: 'u2', cards: ['0000:4f:00.0'] }),
    ]);
    expect(summary).toEqual({ total: 3, running: 2, stopped: 1, attention: 1, owners: 2, servers: 2, gpuCards: 3 });
  });
});

describe('container list search params', () => {
  it('keeps known groupings and well-formed fold lists only', () => {
    expect(parseContainerListSearch({ group: 'owner', collapsed: 'u1,u2' })).toEqual({ group: 'owner', collapsed: 'u1,u2' });
    expect(parseContainerListSearch({ group: 'server', collapsed: 'a,,b' })).toEqual({ group: undefined, collapsed: undefined });
    expect(parseContainerListSearch({ group: 'none', collapsed: 'u1' })).toEqual({ group: 'none', collapsed: undefined });
    expect(parseContainerListSearch({ collapsed: 42 })).toEqual({ group: undefined, collapsed: undefined });
  });

  it('round-trips the folded keys, dropping the parameter when nothing is folded', () => {
    expect(serializeCollapsed(['s2', 's1', 's2'])).toBe('s1,s2');
    expect(serializeCollapsed([])).toBeUndefined();
    expect([...collapsedKeys({ collapsed: 's1,s2' })]).toEqual(['s1', 's2']);
    expect(collapsedKeys({}).size).toBe(0);
  });
});
