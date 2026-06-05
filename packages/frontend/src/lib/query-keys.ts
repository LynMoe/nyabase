type Plane = 'admin' | 'user';

export const queryKeys = {
  servers: {
    admin: ['servers', 'admin'] as const,
    user: ['servers', 'user'] as const,
    detail: (serverId: string) => ['server', serverId] as const,
    disks: (plane: Plane, serverId: string) => ['disks', plane, serverId] as const,
  },
  images: {
    admin: ['images', 'admin'] as const,
    userActive: ['images', 'user', 'active'] as const,
    status: (imageId: string) => ['image-status', 'admin', imageId] as const,
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
  },
  dataDirs: {
    byServer: (plane: Plane, serverId: string) => ['data-dirs', plane, serverId] as const,
    allUser: ['data-dirs', 'user'] as const,
  },
  mountSources: {
    byServer: (plane: Plane, serverId: string) => ['mount-sources', plane, serverId] as const,
    allUser: ['mount-sources', 'user'] as const,
  },
};
