export const SHARED_BACKEND_DETAIL_TABS = ['overview', 'executors', 'volumes'] as const;
export type SharedBackendDetailTab = (typeof SHARED_BACKEND_DETAIL_TABS)[number];

export function parseSharedBackendDetailTab(value: unknown): SharedBackendDetailTab {
  return SHARED_BACKEND_DETAIL_TABS.includes(value as SharedBackendDetailTab)
    ? (value as SharedBackendDetailTab)
    : 'overview';
}
