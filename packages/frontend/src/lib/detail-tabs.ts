

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

export const CONTAINER_SCRIPT_DETAIL_TABS = ['targets', 'runs', 'versions', 'script'] as const;
export type ContainerScriptDetailTab = (typeof CONTAINER_SCRIPT_DETAIL_TABS)[number];

export function parseContainerScriptDetailTab(value: unknown): ContainerScriptDetailTab {
  return CONTAINER_SCRIPT_DETAIL_TABS.includes(value as ContainerScriptDetailTab)
    ? (value as ContainerScriptDetailTab)
    : 'targets';
}

export type ContainerScriptSearch = {
  tab: ContainerScriptDetailTab;
  /** 执行记录: only this container's runs. */
  container?: string;
};

export function parseContainerScriptSearch(search: Record<string, unknown>): ContainerScriptSearch {
  const container = typeof search.container === 'string' && /^[0-9a-f-]{36}$/i.test(search.container)
    ? search.container
    : undefined;
  return { tab: parseContainerScriptDetailTab(search.tab), container };
}
