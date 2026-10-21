export type DetailTab = 'overview' | 'console';
export const DETAIL_TABS: DetailTab[] = ['overview', 'console'];

export function parseDetailTab(value: unknown): DetailTab {
  return DETAIL_TABS.includes(value as DetailTab) ? (value as DetailTab) : 'overview';
}
