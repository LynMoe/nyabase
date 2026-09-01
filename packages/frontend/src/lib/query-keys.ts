type Plane = 'admin' | 'user';
type GrantKind = 'users' | 'groups';
type GrantSlice = 'servers' | 'pools' | 'backends' | 'effective-access';

export const queryKeys = {
  publicSettings: ['public-settings'] as const,
  meAccess: ['me', 'access'] as const,
  certificate: ['incus-client-certificate'] as const,
  systemSettings: ['system-settings'] as const,
  catalog: { users: ['catalog', 'users'] as const },
  audit: {
    list: (pageSize: number, offset: number) => ['audit', pageSize, offset] as const,
    detail: (id: string) => ['audit-detail', id] as const,
  },
  sshProxy: {
    status: ['ssh-proxy-status'] as const,
    hostKey: ['ssh-proxy-host-key'] as const,
  },
  servers: {
    admin: ['servers', 'admin'] as const,
    user: ['servers', 'user'] as const,
    detail: (serverId: string) => ['server', serverId] as const,
    pools: (serverId: string, admin: boolean) => ['storage-pools', admin ? 'admin' : 'user', serverId] as const,
    gpus: (serverId: string, admin: boolean) => ['server-gpus', admin ? 'admin' : 'user', serverId] as const,
    preflight: (serverId: string) => ['server-preflight', serverId] as const,
  },
  images: {
    admin: ['images', 'admin'] as const,
    userActive: ['images', 'user', 'active'] as const,
    assignments: (imageId: string) => ['image-assignments', imageId] as const,
  },
  users: { admin: ['users', 'admin'] as const },
  groups: {
    admin: ['groups', 'admin'] as const,
    detail: (id: string) => ['group', id] as const,
  },
  containers: {
    adminList: ['containers', 'admin'] as const,
    userList: ['containers', 'user'] as const,
    detail: (plane: Plane, containerId: string) => ['container', plane, containerId] as const,
    stats: (plane: Plane, containerId: string) => ['container', plane, containerId, 'stats'] as const,
    intents: (plane: Plane, containerId: string) => ['container-intents', plane, containerId] as const,
    attachments: (plane: Plane, containerId: string) =>
      ['container-attachments', plane, containerId] as const,
  },
  volumes: {
    user: ['volumes', 'user'] as const,
    admin: ['volumes', 'admin'] as const,
    intents: (volumeId: string, admin: boolean) => ['volume-intents', admin ? 'admin' : 'user', volumeId] as const,
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
    pools: (serverId: string) => ['volume-form', 'pools', serverId] as const,
  },
  sharedBackends: {
    user: ['shared-backends', 'user'] as const,
    admin: ['shared-backends', 'admin'] as const,
  },
  ipPools: { admin: ['ip-pools', 'admin'] as const },
  httpProxy: {
    bindings: ['http-proxy', 'bindings', 'user'] as const,
    domainPools: ['http-proxy', 'domain-pools', 'user'] as const,
    adminStatus: ['http-proxy', 'admin', 'status'] as const,
    adminDomainPools: ['http-proxy', 'admin', 'domain-pools'] as const,
    adminBindings: ['http-proxy', 'admin', 'bindings'] as const,
  },
  storagePools: {
    adminIndex: ['storage-pools', 'admin'] as const,
  },
  storageCapacity: (serverId: string) => ['storage-capacity', serverId] as const,
  resourceIntentFailures: (plane: Plane, listPath: string) =>
    ['resource-intent-failures', plane, listPath] as const,
  grants: {
    subject: (kind: GrantKind, subjectId: string) => ['grants', kind, subjectId] as const,
    subjectList: (kind: GrantKind, subjectId: string, slice: GrantSlice) =>
      ['grants', kind, subjectId, slice] as const,
    targets: {
      servers: ['grant-targets', 'servers'] as const,
      pools: ['grant-targets', 'pools'] as const,
      backends: ['grant-targets', 'backends'] as const,
    },
  },
} as const;
