import { describe, expect, it } from 'vitest';
import { Capability } from '@nyabase/common';
import { isAdminImageDto, isGroupDto } from './conflict-snapshots.js';

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

  it('rejects partial image runtime data before it can reach a form', () => {
    const image = {
      id: 'i', name: 'Image', dockerImage: 'alpine:3.20', description: null,
      isActive: true, disableSsh: false, deleting: false, cleanupGeneration: 0,
      revision: 2, createdAt: 'now', updatedAt: 'now',
      runtimeOverrides: { uid: 0, entrypoint: null, cmd: null, init: false },
    };
    expect(isAdminImageDto(image)).toBe(true);
    expect(isAdminImageDto({ ...image, runtimeOverrides: { uid: 0 } })).toBe(false);
  });
});
