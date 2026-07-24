import type { ServerStatus, UserGpuDto, UserStatus } from '@nyabase/common';

export const adminCatalogPaths = {
  users: '/admin/catalog/users',
  groups: '/admin/catalog/groups',
  grantServers: '/admin/catalog/grant-servers',
  grantImages: '/admin/catalog/grant-images',
  grantRemoteFsMounts: '/admin/catalog/grant-remote-fs-mounts',
  metricServers: '/admin/catalog/metric-servers',
  administrationActions: '/admin/catalog/administration-actions',
} as const;

export interface AdminCatalogUser {
  id: string;
  username: string;
  displayName: string | null;
  status: UserStatus;
}

export interface AdminCatalogGroup {
  id: string;
  name: string;
  isSystem: boolean;
}

export interface GrantServerCatalogItem {
  id: string;
  name: string;
  slug: string;
  status: ServerStatus;
  runtimeReady: boolean;
  gpus: UserGpuDto[];
}

export interface GrantImageCatalogItem {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
}

export interface GrantRemoteFsMountCatalogItem {
  id: string;
  name: string;
  displayName: string | null;
  serverIds: string[];
}

export interface MetricServerCatalogItem {
  id: string;
  name: string;
  slug: string;
  status: ServerStatus;
  runtimeReady: boolean;
  hasGpu: boolean;
}
