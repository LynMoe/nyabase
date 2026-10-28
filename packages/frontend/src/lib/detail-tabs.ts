

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
