type Plane = 'admin' | 'user';

export const queryKeys = {
  servers: {
    admin: ['servers', 'admin'] as const,
    user: ['servers', 'user'] as const,
    detail: (serverId: string) => ['server', serverId] as const,
    pools: (serverId: string, admin: boolean) => ['storage-pools', admin ? 'admin' : 'user', serverId] as const,
    gpus: (serverId: string, admin: boolean) => ['server-gpus', admin ? 'admin' : 'user', serverId] as const,
    preflight: (serverId: string) => ['server-preflight', serverId] as const,
  },
  grants: {
    subject: (kind: 'users' | 'groups', subjectId: string) => ['grants', kind, subjectId] as const,
  },
  images: {
    admin: ['images', 'admin'] as const,
    userActive: ['images', 'user', 'active'] as const,
    assignments: (imageId: string) => ['image-assignments', imageId] as const,
  },
  users: {
    admin: ['users', 'admin'] as const,
  },
  groups: {
    admin: ['groups', 'admin'] as const,
  },
  containers: {
    adminList: ['containers', 'admin'] as const,
    userList: ['containers', 'user'] as const,
    detail: (plane: Plane, containerId: string) => ['container', plane, containerId] as const,
    stats: (plane: Plane, containerId: string) => ['container', plane, containerId, 'stats'] as const,
    intents: (plane: Plane, containerId: string) => ['container-intents', plane, containerId] as const,
  },
  volumes: {
    user: ['volumes', 'user'] as const,
    admin: ['volumes', 'admin'] as const,
    intents: (volumeId: string, admin: boolean) => ['volume-intents', admin ? 'admin' : 'user', volumeId] as const,
  },
  sharedBackends: {
    user: ['shared-backends', 'user'] as const,
    admin: ['shared-backends', 'admin'] as const,
  },
  ipPools: {
    admin: ['ip-pools', 'admin'] as const,
  },
  httpProxy: {
    bindings: ['http-proxy', 'bindings', 'user'] as const,
    domainPools: ['http-proxy', 'domain-pools', 'user'] as const,
    adminStatus: ['http-proxy', 'admin', 'status'] as const,
    adminDomainPools: ['http-proxy', 'admin', 'domain-pools'] as const,
    adminBindings: ['http-proxy', 'admin', 'bindings'] as const,
  },
};
