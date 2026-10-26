

export const GROUP_DETAIL_TABS = ['overview', 'members', 'grants'] as const;
export type GroupDetailTab = (typeof GROUP_DETAIL_TABS)[number];

export function parseGroupDetailTab(value: unknown): GroupDetailTab {
  return GROUP_DETAIL_TABS.includes(value as GroupDetailTab)
    ? (value as GroupDetailTab)
    : 'overview';
}

export const IMAGE_DETAIL_TABS = ['overview', 'versions', 'assignments'] as const;
export type ImageDetailTab = (typeof IMAGE_DETAIL_TABS)[number];

export function parseImageDetailTab(value: unknown): ImageDetailTab {
  return IMAGE_DETAIL_TABS.includes(value as ImageDetailTab)
    ? (value as ImageDetailTab)
    : 'overview';
}

export const SHARED_BACKEND_DETAIL_TABS = ['overview', 'executors', 'volumes'] as const;
export type SharedBackendDetailTab = (typeof SHARED_BACKEND_DETAIL_TABS)[number];

export function parseSharedBackendDetailTab(value: unknown): SharedBackendDetailTab {
  return SHARED_BACKEND_DETAIL_TABS.includes(value as SharedBackendDetailTab)
    ? (value as SharedBackendDetailTab)
    : 'overview';
}

export const USER_DETAIL_TABS = ['overview', 'grants'] as const;
export type UserDetailTab = (typeof USER_DETAIL_TABS)[number];

export function parseUserDetailTab(value: unknown): UserDetailTab {
  return USER_DETAIL_TABS.includes(value as UserDetailTab)
    ? (value as UserDetailTab)
    : 'overview';
}
