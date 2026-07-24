import { describe, expect, it } from 'vitest';
import type {
  ActionAvailabilityDto,
  GroupAdministrationAvailabilityDto,
} from '@nyabase/common';
import { groupMemberActionAvailability } from './group-member-action.js';

const allowed: ActionAvailabilityDto = { allowed: true, reason: null, missingCapabilities: [] };
const denied: ActionAvailabilityDto = {
  allowed: false,
  reason: '不能移出最后一个活跃管理员',
  missingCapabilities: [],
};

function group(
  canRemoveMembers: GroupAdministrationAvailabilityDto['canRemoveMembers'],
): GroupAdministrationAvailabilityDto {
  return {
    canEditMetadata: allowed,
    canEditPriority: allowed,
    canManageMembers: allowed,
    canRemoveMembers,
    canDelete: allowed,
  };
}

describe('group member action availability', () => {
  it('fails closed when a newly observed member is missing from the action snapshot', () => {
    const result = groupMemberActionAvailability(group({}), 'just-joined', true);
    expect(result).toMatchObject({ allowed: false });
    expect(result.reason).toContain('快照不一致');
  });

  it('honors the target-specific final-administrator denial', () => {
    expect(groupMemberActionAvailability(group({ admin: denied }), 'admin', true)).toBe(denied);
  });

  it('uses group-wide authority only for adding a non-member', () => {
    expect(groupMemberActionAvailability(group({}), 'candidate', false)).toBe(allowed);
  });
});
