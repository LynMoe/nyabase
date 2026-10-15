import { describe, expect, it } from 'vitest';
import type { ContainerDto } from '@nyabase/common';
import { containerStatusOptions, filterContainers } from './container-filter.js';
import { matchesSearch } from '../components/layout/list-search.js';

function container(partial: Partial<ContainerDto> & { status?: string }): ContainerDto {
  return {
    name: 'c', serverName: 's', routedIp: null, ownerName: null, imageName: null, needsAttention: false,
    ...partial,
    actual: { status: partial.status ?? 'running' },
  } as unknown as ContainerDto;
}

describe('container list filtering', () => {
  const rows = [
    container({ name: 'dev-ubuntu', serverName: 'lab-a', ownerName: 'alice' }),
    container({ name: 'train', serverName: 'lab-b', status: 'stopped', needsAttention: true }),
  ];

  it('matches every word against any field, case-insensitively', () => {
    expect(matchesSearch('DEV lab-a', ['dev-ubuntu', 'lab-a'])).toBe(true);
    expect(matchesSearch('dev lab-b', ['dev-ubuntu', 'lab-a'])).toBe(false);
    expect(matchesSearch('  ', [])).toBe(true);
  });

  it('combines search with the status segment', () => {
    expect(filterContainers(rows, 'alice', 'all').map((row) => row.name)).toEqual(['dev-ubuntu']);
    expect(filterContainers(rows, '', 'stopped').map((row) => row.name)).toEqual(['train']);
    expect(filterContainers(rows, '', 'attention').map((row) => row.name)).toEqual(['train']);
  });

  it('only offers 需要处理 when something needs it', () => {
    expect(containerStatusOptions(rows).map((option) => option.value)).toContain('attention');
    expect(containerStatusOptions(rows.slice(0, 1)).map((option) => option.value)).not.toContain('attention');
  });
});
