export const USER_DETAIL_TABS = ['overview', 'grants'] as const;
export type UserDetailTab = (typeof USER_DETAIL_TABS)[number];

export function parseUserDetailTab(value: unknown): UserDetailTab {
  return USER_DETAIL_TABS.includes(value as UserDetailTab)
    ? (value as UserDetailTab)
    : 'overview';
}
