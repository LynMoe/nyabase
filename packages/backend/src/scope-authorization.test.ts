import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Role } from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';
import { assertListScope, isSystemActor, SYSTEM_ACTOR } from './iam/actor.js';
import { testActor } from './iam/actor.test-helper.js';
import { GpuService } from './gpu/gpu.service.js';
import { HttpDomainPoolsService } from './http-proxy/http-domain-pools.service.js';
import { HttpProxyBindingsService } from './http-proxy/http-proxy-bindings.service.js';
import { ImagesService } from './images/images.service.js';
import { PerformanceQueryService } from './metrics/performance-query.service.js';
import { zSeriesQuery, zUsageQuery } from './metrics/performance.controller.js';
import { ServersService } from './servers/servers.service.js';
import { StoragePoolsService } from './storage-pools/storage-pools.service.js';
import { LocalVolumesService } from './volumes/local-volumes.service.js';
import { SharedVolumesService } from './volumes/shared-volumes.service.js';

const user = testActor('user-a');

describe('assertListScope', () => {
  it('lets scope=mine through and requires the role for scope=all', () => {
    expect(() => assertListScope(user, 'mine', Role.UserAdmin)).not.toThrow();
    expect(() => assertListScope(user, 'all', Role.UserAdmin)).toThrow(ForbiddenException);
    expect(() => assertListScope(testActor('b', Role.UserAdmin), 'all', Role.UserAdmin)).not.toThrow();
    expect(() => assertListScope(testActor('b', Role.UserAdmin), 'all', Role.Admin)).toThrow(ForbiddenException);
  });

  it('treats the system actor as privileged without a role', () => {
    expect(isSystemActor(SYSTEM_ACTOR)).toBe(true);
    expect(SYSTEM_ACTOR.userId).toBeNull();
    expect(isSystemActor(user)).toBe(false);
    expect(() => assertListScope(SYSTEM_ACTOR, 'all', Role.Admin)).not.toThrow();
  });
});

// scope=all is refused before any dependency is touched, so bare services suffice.
describe('scope=all needs the resource role', () => {
  const bare = <T>(Service: new (...args: never[]) => T, count: number): T =>
    new Service(...(Array.from({ length: count }, () => ({})) as never[]));

  it('servers: user admins list every server as user DTOs; the admin view is admin-only', async () => {
    const servers = bare(ServersService, 7);
    const userAdmin = testActor('g', Role.UserAdmin);
    await expect(servers.list(user, 'all')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(servers.get(user, 's1', 'all')).rejects.toBeInstanceOf(ForbiddenException);
    const findUserDtoById = vi.spyOn(servers, 'findUserDtoById').mockResolvedValue({ id: 's1' } as never);
    await expect(servers.get(userAdmin, 's1', 'all')).resolves.toEqual({ id: 's1' });
    expect(findUserDtoById).toHaveBeenCalledWith('s1');
    const findAllDtos = vi.spyOn(servers, 'findAllDtos').mockResolvedValue([]);
    const findAll = vi.spyOn(servers, 'findAll').mockResolvedValue([]);
    await expect(servers.list(userAdmin, 'all')).resolves.toEqual([]);
    expect(findAll).toHaveBeenCalled();
    expect(findAllDtos).not.toHaveBeenCalled();
    await expect(servers.list(testActor('a', Role.Admin), 'all')).resolves.toEqual([]);
    expect(findAllDtos).toHaveBeenCalled();
  });

  it('servers: scope=mine hides servers the user holds no grant for', async () => {
    const servers = bare(ServersService, 7);
    Object.assign((servers as unknown as { access: object }).access, {
      listAccessibleServers: vi.fn().mockResolvedValue(['s1']),
    });
    await expect(servers.get(user, 's2', 'mine')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('images: list and get(scope=all) need the admin role', async () => {
    const images = bare(ImagesService, 8);
    for (const actor of [user, testActor('g', Role.UserAdmin)]) {
      await expect(images.list(actor, 'all')).rejects.toBeInstanceOf(ForbiddenException);
      await expect(images.get(actor, 'i1', 'all')).rejects.toBeInstanceOf(ForbiddenException);
    }
  });

  it('images: scope=mine refuses an image the user may not use (403)', async () => {
    const images = bare(ImagesService, 8);
    vi.spyOn(images, 'findById').mockResolvedValue({ id: 'i1', deleting: false } as never);
    Object.assign((images as unknown as { access: object }).access, {
      isImageAccessible: vi.fn().mockResolvedValue(false),
    });
    await expect(images.get(user, 'i1', 'mine')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('storage pools, gpu devices, performance, http proxy', async () => {
    await expect(bare(StoragePoolsService, 4).listForServer(user, 's1', 'all'))
      .rejects.toBeInstanceOf(ForbiddenException);
    await expect(bare(GpuService, 7).listDevices(user, 's1', 'all'))
      .rejects.toBeInstanceOf(ForbiddenException);
    const performance = bare(PerformanceQueryService, 4);
    await expect(performance.usage(user, {}, 'all')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(performance.series(user, {}, 'all')).rejects.toBeInstanceOf(ForbiddenException);
    // `userId` picks another person's usage: an administrator filter, never under scope=mine.
    await expect(performance.usage(user, { userId: 'u2' }, 'mine')).rejects.toBeInstanceOf(BadRequestException);
    await expect(performance.usage(user, { userId: 'u2', containerId: 'c1' }, 'mine'))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(performance.series(user, { userId: 'u2', metrics: 'cpu' }, 'mine'))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(zUsageQuery.safeParse({ userId: 'u2' }).success).toBe(false);
    expect(zSeriesQuery.safeParse({ scope: 'mine', userId: 'u2', range: '1h' }).success).toBe(false);
    expect(zSeriesQuery.parse({ scope: 'all', userId: 'u2', range: '1h' })).toMatchObject({ userId: 'u2' });
    expect(zUsageQuery.parse({ serverId: 's1', containerId: 'c1' })).toMatchObject({ scope: 'mine' });
    const bindings = bare(HttpProxyBindingsService, 3);
    const pools = bare(HttpDomainPoolsService, 4);
    await expect(bindings.listBindings(user, 'all', true)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(bindings.deleteBinding(user, 'b1', 'all')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(pools.listPools(user, 'all')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(pools.listPools(testActor('g', Role.UserAdmin), 'all')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('volumes: local, shared and capacity need the user admin role', async () => {
    const volumes = bare(LocalVolumesService, 8);
    const shared = bare(SharedVolumesService, 8);
    await expect(volumes.list(user, { scope: 'all' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(shared.list(user, { scope: 'all' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(volumes.capacity(user, 's1', 'all')).rejects.toBeInstanceOf(ForbiddenException);
  });
});
