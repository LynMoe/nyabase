import { describe, expect, it } from 'vitest';
import { Capability } from '@nyabase/common';
import { isGroupDto } from './conflict-snapshots.js';

describe('conflict snapshot validators', () => {
  it('accepts a complete group snapshot and rejects a missing revision', () => {
    const group = {
      id: 'g', name: 'Group', description: null, priority: 1, isSystem: false,
      capabilities: [Capability.ManageGroups], revision: 2,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    expect(isGroupDto(group)).toBe(true);
    expect(isGroupDto({ ...group, revision: undefined })).toBe(false);
  });
});
