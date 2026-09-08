export const GROUP_DETAIL_TABS = ['overview', 'members', 'grants'] as const;
export type GroupDetailTab = (typeof GROUP_DETAIL_TABS)[number];

export function parseGroupDetailTab(value: unknown): GroupDetailTab {
  return GROUP_DETAIL_TABS.includes(value as GroupDetailTab)
    ? (value as GroupDetailTab)
    : 'overview';
}
