import { describe, expect, it } from 'vitest';
import {
  nextDefaultGpuSelection,
  permittedGpus,
  samePciSelection,
} from './selection.js';

const inventory = [
  { index: 0, pciAddress: '00000000:41:00.0', model: 'A' },
  { index: 1, pciAddress: '00000000:81:00.0', model: 'B' },
];

describe('permittedGpus', () => {
  it('shows the inventory when no grant is supplied and filters an explicit list', () => {
    expect(permittedGpus(inventory, null)).toEqual(inventory);
    expect(permittedGpus(inventory, { pciAddresses: [] })).toEqual([]);
    expect(permittedGpus(inventory, { pciAddresses: ['0000:81:00.0'] })).toEqual([
      inventory[1],
    ]);
  });
});

describe('nextDefaultGpuSelection', () => {
  it('selects every available card until the user edits the list', () => {
    expect(nextDefaultGpuSelection('server', ['a', 'b'], [], null)).toEqual(['a', 'b']);
    expect(nextDefaultGpuSelection('server', ['a', 'b'], ['a', 'b'], {
      serverId: 'server',
      addresses: ['a', 'b'],
    })).toBeNull();
    expect(nextDefaultGpuSelection('server', ['a', 'b', 'c'], ['a'], {
      serverId: 'server',
      addresses: ['a', 'b'],
    })).toBeNull();
    expect(nextDefaultGpuSelection('other', ['c'], [], {
      serverId: 'server',
      addresses: ['a', 'b'],
    })).toEqual(['c']);
  });

  it('treats canonical PCI aliases as the same selection', () => {
    expect(samePciSelection(['0000:41:00.0'], ['00000000:41:00.0'])).toBe(true);
  });
});
