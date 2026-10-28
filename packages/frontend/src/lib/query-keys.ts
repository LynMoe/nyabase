import type { ListScope } from '@nyabase/common';

/** Which rows a cached response holds: the caller's own (`mine`) or everyone's (`all`). */
type Scope = ListScope;
type GrantSlice = 'servers' | 'backends' | 'effective-access';

export const queryKeys = {
  publicSettings: ['public-settings'] as const,
  meAccess: ['me', 'access'] as const,
  systemSettings: ['system-settings'] as const,
  catalog: { users: ['catalog', 'users'] as const },
  sshKeys: (userId: string) => ['ssh-keys', userId] as const,
  sshClientConfig: (userId: string) => ['ssh-client-config', userId] as const,
  audit: {
    list: (pageSize: number, offset: number, filter: { action?: string; targetType?: string } = {}) =>
      ['audit', pageSize, offset, filter.action ?? null, filter.targetType ?? null] as const,
    detail: (id: string) => ['audit-detail', id] as const,
  },
  sshProxy: {
    status: ['ssh-proxy-status'] as const,
    hostKey: ['ssh-proxy-host-key'] as const,
    lines: ['ssh-proxy-lines'] as const,
    refusals: (hours: number) => ['ssh-proxy-refusals', hours] as const,
  },
  sshSessions: {
    list: (scope: Scope, filters: object, limit: number, cursor: string | undefined) =>
      ['ssh-sessions', scope, filters, limit, cursor ?? null] as const,
    detail: (scope: Scope, id: string) => ['ssh-session', scope, id] as const,
    stats: (scope: Scope, days: number, containerId: string | undefined) =>
      ['ssh-session-stats', scope, days, containerId ?? null] as const,
  },
  servers: {
    admin: ['servers', 'admin'] as const,
    user: ['servers', 'user'] as const,
    rejectedAgents: ['servers', 'rejected-agents'] as const,
    detail: (serverId: string) => ['server', serverId] as const,
    pools: (serverId: string, scope: ListScope) => ['storage-pools', scope, serverId] as const,
    preflight: (serverId: string) => ['server-preflight', serverId] as const,
  },
  gpu: {
    devices: (serverId: string, scope: ListScope) => ['gpu-devices', scope, serverId] as const,
    server: (serverId: string) => ['server-gpu', 'admin', serverId] as const,
  },
  images: {
    admin: ['images', 'admin'] as const,
    catalog: ['images', 'admin', 'catalog'] as const,
    userActive: ['images', 'user', 'active'] as const,
    detail: (imageId: string) => ['images', 'admin', imageId] as const,
    versions: (imageId: string) => ['images', 'admin', imageId, 'versions'] as const,
    assignments: (imageId: string) => ['image-assignments', imageId] as const,
  },
  users: {
    admin: ['users', 'admin'] as const,
    detail: (userId: string) => ['users', 'admin', userId] as const,
  },
  grantBundles: {
    all: ['grant-bundles'] as const,
    list: ['grant-bundles', 'list'] as const,
    serverProfile: (serverId: string) => ['grant-bundles', 'server-profile', serverId] as const,
  },
  containers: {
    adminList: ['containers', 'admin'] as const,
    userList: ['containers', 'user'] as const,
    detail: (scope: Scope, containerId: string) => ['container', scope, containerId] as const,
    stats: (scope: Scope, containerId: string) => ['container', scope, containerId, 'stats'] as const,
    intents: (scope: Scope, containerId: string) => ['container-intents', scope, containerId] as const,
    attachments: (scope: Scope, containerId: string) =>
      ['container-attachments', scope, containerId] as const,
  },
  volumes: {
    user: ['volumes', 'user'] as const,
    admin: ['volumes', 'admin'] as const,
    adminByServer: (serverId: string) => ['volumes', 'admin', serverId] as const,
  },
  sharedVolumes: {
    all: ['shared-volumes'] as const,
    user: ['shared-volumes', 'user'] as const,
    admin: ['shared-volumes', 'admin'] as const,
    attachable: (serverId: string) => ['shared-volumes', 'attachable', serverId] as const,
    catalogs: (volumeId: string) => ['shared-volumes', 'catalogs', volumeId] as const,
    backendInspect: (backendId: string) => ['shared-backends', 'catalog-inspect', backendId] as const,
  },
  volumeForm: {
    servers: ['volume-form', 'servers'] as const,
    /** Prefix of every server's `pools`. */
    poolsAll: ['volume-form', 'pools'] as const,
    pools: (serverId: string) => ['volume-form', 'pools', serverId] as const,
  },
  sharedBackends: {
    user: ['shared-backends', 'user'] as const,
    admin: ['shared-backends', 'admin'] as const,
    detail: (backendId: string) => ['shared-backends', 'admin', backendId] as const,
  },
  ipPools: { admin: ['ip-pools', 'admin'] as const },
  firewall: {
    all: ['firewall'] as const,
    rules: ['firewall', 'rules'] as const,
    status: ['firewall', 'status'] as const,
  },
  httpProxy: {
    bindings: ['http-proxy', 'bindings', 'user'] as const,
    domainPools: ['http-proxy', 'domain-pools', 'user'] as const,
    adminStatus: ['http-proxy', 'admin', 'status'] as const,
    adminDomainPools: ['http-proxy', 'admin', 'domain-pools'] as const,
    adminBindings: ['http-proxy', 'admin', 'bindings'] as const,
  },
  performance: {
    usage: (scope: Scope, serverId: string) => ['performance', 'usage', scope, serverId] as const,
    servers: (scope: Scope) => ['performance', 'servers', scope] as const,
    scoped: (scope: Scope, serverId: string) => ['performance', 'scoped', scope, serverId] as const,
    spark: (scope: Scope) => ['performance', 'spark', scope] as const,
    self: (scope: Scope, containerId: string) => ['performance', 'self', scope, containerId] as const,
    multi: (scope: Scope, serverId: string, containerId: string, range: string) =>
      ['performance', 'multi', scope, serverId, containerId, range] as const,
    series: (
      scope: Scope,
      serverId: string,
      userId: string,
      containerId: string,
      metric: string,
      range: string,
    ) => ['performance', 'series', scope, serverId, userId, containerId, metric, range] as const,
  },
  /** Prefix of every `storageCapacity` (and the admin view's `['storage-capacity', 'admin', id]`). */
  storageCapacityAll: ['storage-capacity'] as const,
  storageCapacity: (serverId: string) => ['storage-capacity', serverId] as const,
  resourceIntentFailures: (listPath: string, limit: number) =>
    ['resource-intent-failures', listPath, limit] as const,
  adminIntents: (filters: {
    status?: string;
    kind?: string;
    resourceType?: string;
    serverId?: string;
    limit: number;
    cursor?: string;
  }) => ['admin-intents', filters] as const,
  adminIntent: (id: string) => ['admin-intent', id] as const,
  grants: {
    user: (userId: string) => ['grants', 'users', userId] as const,
    userList: (userId: string, slice: GrantSlice) => ['grants', 'users', userId, slice] as const,
    /** Every user's server grants (the user list's badges). */
    allServers: ['grants', 'all-servers'] as const,
    targets: {
      servers: ['grant-targets', 'servers'] as const,
      backends: ['grant-targets', 'backends'] as const,
    },
  },
} as const;
