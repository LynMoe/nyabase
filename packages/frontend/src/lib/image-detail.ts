export const IMAGE_DETAIL_TABS = ['overview', 'assignments'] as const;
export type ImageDetailTab = (typeof IMAGE_DETAIL_TABS)[number];

export function parseImageDetailTab(value: unknown): ImageDetailTab {
  return IMAGE_DETAIL_TABS.includes(value as ImageDetailTab)
    ? (value as ImageDetailTab)
    : 'overview';
}
