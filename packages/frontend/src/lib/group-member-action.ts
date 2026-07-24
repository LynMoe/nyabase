import type {
  ActionAvailabilityDto,
  GroupAdministrationAvailabilityDto,
} from '@nyabase/common';

const STALE_MEMBER_DECISION: ActionAvailabilityDto = {
  allowed: false,
  reason: '成员列表与操作权限快照不一致，请刷新后重试',
  missingCapabilities: [],
};

/** Existing-member removals require a target-specific decision. Missing map
 * entries are a cross-snapshot condition and must never inherit group-wide
 * add-member authority. */
export function groupMemberActionAvailability(
  group: GroupAdministrationAvailabilityDto | undefined,
  userId: string,
  isMember: boolean,
): ActionAvailabilityDto {
  if (!group) return STALE_MEMBER_DECISION;
  if (!isMember) return group.canManageMembers;
  return group.canRemoveMembers[userId] ?? STALE_MEMBER_DECISION;
}
