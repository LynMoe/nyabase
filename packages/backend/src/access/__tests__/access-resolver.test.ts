import { describe, it, expect, vi } from 'vitest';
import { Capability, GpuGrantMode } from '@nyabase/common';
// Import from the standalone utility module to avoid loading TypeORM entity decorators
import { resolveGrant } from '../grant-utils.js';

vi.mock('../../entities/group.entity.js', () => ({ GroupEntity: class GroupEntity {} }));
vi.mock('../../entities/group-member.entity.js', () => ({ GroupMemberEntity: class GroupMemberEntity {} }));
vi.mock('../../entities/server-grant.entity.js', () => ({ ServerGrantEntity: class ServerGrantEntity {} }));
vi.mock('../../entities/image-grant.entity.js', () => ({ ImageGrantEntity: class ImageGrantEntity {} }));
vi.mock('../../entities/image.entity.js', () => ({ ImageEntity: class ImageEntity {} }));
vi.mock('../../entities/server.entity.js', () => ({ ServerEntity: class ServerEntity {} }));
vi.mock('../../entities/mount-source-grant.entity.js', () => ({ MountSourceGrantEntity: class MountSourceGrantEntity {} }));
vi.mock('../../entities/remote-fs-server-assignment.entity.js', () => ({
  RemoteFsServerAssignmentEntity: class RemoteFsServerAssignmentEntity {},
}));

import { AccessResolverService } from '../access-resolver.service.js';
import { AccessCacheEpochService } from '../access-cache-epoch.service.js';

// ---------------------------------------------------------------------------
// resolveGrant — pure function, no TypeORM entity imports
// ---------------------------------------------------------------------------

function makeGrant(overrides = {}) {
  return {
    cpuMillis: null as number | null,
    memBytes: null as number | null,
    diskBytes: null as number | null,
    gpuMode: null as GpuGrantMode | null,
    gpuIndices: null as number[] | null,
    ...overrides,
  };
}

describe('resolveGrant', () => {
  it('treats null resource fields as unlimited and null GPU mode as all', () => {
    const result = resolveGrant(makeGrant());
    expect(result.cpuMillis).toBe(0);
    expect(result.memBytes).toBe(0);
    expect(result.diskBytes).toBe(0);
    expect(result.gpuMode).toBe(GpuGrantMode.All);
    expect(result.gpuIndices).toEqual([]);
  });

  it('uses grant values when set (non-null)', () => {
    const result = resolveGrant(
      makeGrant({ cpuMillis: 8000, memBytes: 8 * 1024 ** 3 }),
    );
    expect(result.cpuMillis).toBe(8000);
    expect(result.memBytes).toBe(8 * 1024 ** 3);
    expect(result.diskBytes).toBe(0);
  });

  it('uses grant gpuIndices when set', () => {
    const result = resolveGrant(
      makeGrant({ gpuMode: GpuGrantMode.Indices, gpuIndices: [0, 2] }),
    );
    expect(result.gpuIndices).toEqual([0, 2]);
    expect(result.gpuMode).toBe(GpuGrantMode.Indices);
  });

  it('uses empty gpuIndices when grant gpuIndices is null', () => {
    const result = resolveGrant(
      makeGrant({ gpuMode: GpuGrantMode.Indices }),
    );
    expect(result.gpuIndices).toEqual([]);
  });

  it('uses all GPU mode when grant gpuMode is null', () => {
    const result = resolveGrant(
      makeGrant({ gpuMode: null }),
    );
    expect(result.gpuMode).toBe(GpuGrantMode.All);
    expect(result.gpuIndices).toEqual([]);
  });

  it('preserves zero as an explicit unlimited grant value', () => {
    const result = resolveGrant(
      makeGrant({ cpuMillis: 0 }),
    );
    expect(result.cpuMillis).toBe(0);
  });
});

describe('AccessResolverService image detail authorization', () => {
  it('requires an ordinary user image grant to match an effectively granted server', async () => {
    const service = makeAccessResolver({
      memberships: [],
      groups: [],
      userServerGrants: [makeServerGrant({
        id: 'server-grant-user-a',
        scopeId: 'user-a',
        serverId: 'server-accessible',
      })],
      userImageGrants: [makeImageGrant({
        id: 'image-grant-wrong-server',
        scopeId: 'user-a',
        imageId: 'image-a',
        serverId: 'server-ungranted',
      })],
    });

    await expect(service.isImageAccessibleForUser('user-a', 'image-a')).resolves.toBe(false);
  });

  it('allows an ordinary user when effective server access and image grant share a server', async () => {
    const service = makeAccessResolver({
      memberships: [],
      groups: [],
      userServerGrants: [makeServerGrant({
        id: 'server-grant-user-a',
        scopeId: 'user-a',
        serverId: 'server-accessible',
      })],
      userImageGrants: [makeImageGrant({
        id: 'image-grant-matching-server',
        scopeId: 'user-a',
        imageId: 'image-a',
        serverId: 'server-accessible',
      })],
    });

    await expect(service.isImageAccessibleForUser('user-a', 'image-a')).resolves.toBe(true);
  });

  it('does not let admin capabilities bypass user-plane image authorization', async () => {
    const service = makeAccessResolver({
      memberships: [{
        id: 'member-admin',
        groupId: 'group-admin',
        userId: 'admin-a',
      }],
      groups: [makeGroup({
        id: 'group-admin',
        capabilities: [Capability.ManageImages],
      })],
      userServerGrants: [],
      userImageGrants: [],
    });

    await expect(service.isImageAccessibleForUser('admin-a', 'image-a')).resolves.toBe(false);
  });

  it('does not let admin capabilities synthesize effective resource access', async () => {
    const service = makeAccessResolver({
      memberships: [{
        id: 'member-admin',
        groupId: 'group-admin',
        userId: 'admin-a',
      }],
      groups: [makeGroup({
        id: 'group-admin',
        capabilities: [Capability.ManageContainersAny],
      })],
      userServerGrants: [],
      userImageGrants: [],
    });

    await expect(service.getEffectiveAccess('admin-a')).resolves.toEqual([]);
  });
});

function makeAccessResolver(input: {
  memberships: Array<{ id: string; groupId: string; userId: string }>;
  groups: Array<{
    id: string;
    capabilities: Capability[];
    priority: number;
  }>;
  userServerGrants: Array<ReturnType<typeof makeServerGrant>>;
  userImageGrants: Array<ReturnType<typeof makeImageGrant>>;
}) {
  const groupIds = new Set(input.memberships.map((membership) => membership.groupId));
  const groups = input.groups.filter((group) => groupIds.has(group.id));
  const groupServerGrants: Array<ReturnType<typeof makeServerGrant>> = [];
  const groupImageGrants: Array<ReturnType<typeof makeImageGrant>> = [];

  const groupsRepo = {
    createQueryBuilder: () => ({
      where: () => ({
        orderBy: () => ({
          addOrderBy: () => ({
            getMany: async () => groups,
          }),
        }),
      }),
    }),
  };
  const membersRepo = {
    find: async () => input.memberships,
  };
  const serverGrantsRepo = {
    find: async () => input.userServerGrants,
    createQueryBuilder: () => ({
      where: () => ({
        getMany: async () => groupServerGrants,
      }),
    }),
  };
  const imageGrantsRepo = {
    find: async () => input.userImageGrants,
    createQueryBuilder: () => ({
      where: () => ({
        getMany: async () => groupImageGrants,
      }),
    }),
  };
  const imagesRepo = {
    find: async () => [],
  };
  const mountSourceGrantsRepo = {
    find: async () => [],
    createQueryBuilder: () => ({
      where: () => ({
        getMany: async () => [],
      }),
    }),
  };
  const remoteFsAssignmentsRepo = {
    find: async () => [],
  };
  const serversRepo = {
    find: async () => [
      makeServer('server-accessible'),
      makeServer('server-ungranted'),
    ],
  };
  const agentGateway = {
    stateCache: {
      get: () => undefined,
      getAll: () => [],
    },
  };

  return new AccessResolverService(
    groupsRepo as never,
    membersRepo as never,
    serverGrantsRepo as never,
    imageGrantsRepo as never,
    imagesRepo as never,
    serversRepo as never,
    mountSourceGrantsRepo as never,
    remoteFsAssignmentsRepo as never,
    agentGateway as never,
    new AccessCacheEpochService(),
  );
}

function makeGroup(input: {
  id: string;
  capabilities: Capability[];
}) {
  return {
    id: input.id,
    name: input.id,
    priority: 100,
    isSystem: true,
    capabilities: input.capabilities,
  };
}

function makeServer(id: string) {
  return {
    id,
    name: id,
    agentTokenHash: `token-${id}`,
  };
}

function makeServerGrant(input: {
  id: string;
  scopeId: string;
  serverId: string;
}) {
  return {
    id: input.id,
    scope: 'user',
    scopeId: input.scopeId,
    serverId: input.serverId,
    cpuMillis: null,
    memBytes: null,
    diskBytes: null,
    gpuMode: GpuGrantMode.None,
    gpuIndices: null,
  };
}

function makeImageGrant(input: {
  id: string;
  scopeId: string;
  imageId: string;
  serverId: string;
}) {
  return {
    id: input.id,
    scope: 'user',
    scopeId: input.scopeId,
    imageId: input.imageId,
    serverId: input.serverId,
  };
}
