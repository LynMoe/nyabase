import { describe, expect, it } from 'vitest';
import { publicDataDiskDisplayName } from './utils.js';

describe('publicDataDiskDisplayName', () => {
  it('uses an explicit safe label but never derives a label from a host path', () => {
    expect(publicDataDiskDisplayName('disk-a', 'Shared data')).toBe('Shared data');
    expect(publicDataDiskDisplayName('disk-a', null)).toBe('Local disk disk-a');
    expect(publicDataDiskDisplayName('disk-a', '/srv/private/customer')).toBe(
      'Local disk disk-a',
    );
    expect(publicDataDiskDisplayName('disk-a', 'private\\customer')).toBe(
      'Local disk disk-a',
    );
  });
});
