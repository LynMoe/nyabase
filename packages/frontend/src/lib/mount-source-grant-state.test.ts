import { describe, expect, it } from 'vitest';
import type { MountSourceGrantDto } from '@nyabase/common';
import { classifyOrphanedLocalGrants, exactLocalGrantKey } from './mount-source-grant-state.js';

const grant: MountSourceGrantDto = {
  id: 'g1',
  scope: 'user',
  scopeId: 'u1',
  sourceKind: 'local',
  sourceId: 'disk-a',
  serverId: 'server-a',
  sourceIdentity: 'xfs:uuid-old',
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('local mount-source grant identity', () => {
  it('matches only the exact physical source identity', () => {
    expect(exactLocalGrantKey('server-a', 'disk-a', 'xfs:uuid-old'))
      .not.toBe(exactLocalGrantKey('server-a', 'disk-a', 'xfs:uuid-new'));
    expect(classifyOrphanedLocalGrants([grant], [{
      serverId: 'server-a', diskId: 'disk-a', sourceIdentity: 'xfs:uuid-old',
    }])).toEqual([]);
  });

  it('keeps missing/offline inventory grants removable as orphans', () => {
    expect(classifyOrphanedLocalGrants([grant], [])).toEqual([grant]);
  });

  it('classifies a reused disk id with a different identity as replaced', () => {
    expect(classifyOrphanedLocalGrants([grant], [{
      serverId: 'server-a', diskId: 'disk-a', sourceIdentity: 'xfs:uuid-new',
    }])).toEqual([grant]);
  });
});
