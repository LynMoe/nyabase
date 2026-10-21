import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Capability } from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';
import { assertListScope, isSystemActor, SYSTEM_ACTOR, systemActor } from './iam/actor.js';
import { testActor } from './iam/actor.test-helper.js';
import { GpuService } from './gpu/gpu.service.js';
import { HttpDomainPoolsService } from './http-proxy/http-domain-pools.service.js';
import { HttpProxyBindingsService } from './http-proxy/http-proxy-bindings.service.js';
import { ImagesService } from './images/images.service.js';
import { PerformanceQueryService } from './metrics/performance-query.service.js';
import { ServersService } from './servers/servers.service.js';
import { StoragePoolsService } from './storage-pools/storage-pools.service.js';
import { LocalVolumesService } from './volumes/local-volumes.service.js';
import { SharedVolumesService } from './volumes/shared-volumes.service.js';

const user = testActor('user-a');

describe('assertListScope', () => {
  it('lets scope=mine through and requires one of the capabilities for scope=all', () => {
    expect(() => assertListScope(user, 'mine', Capability.ManageServers)).not.toThrow();
    expect(() => assertListScope(user, 'all', Capability.ManageServers)).toThrow(ForbiddenException);
    expect(() => assertListScope(
      testActor('b', Capability.ManageGrants),
      'all',
      Capability.ManageServers,
      Capability.ManageGrants,
    )).not.toThrow();
  });

  it('treats the system actor as privileged without capabilities', () => {
    expect(isSystemActor(SYSTEM_ACTOR)).toBe(true);
    expect(isSystemActor(systemActor('system-user'))).toBe(true);
    expect(systemActor('system-user').userId).toBe('system-user');
    expect(isSystemActor(user)).toBe(false);
    expect(() => assertListScope(SYSTEM_ACTOR, 'all', Capability.ManageServers)).not.toThrow();
  });
});

// scope=all is refused before any dependency is touched, so bare services suffice.
describe('scope=all needs the resource capability', () => {
  const bare = <T>(Service: new (...args: never[]) => T, count: number): T =>
    new Service(...(Array.from({ length: count }, () => ({})) as never[]));

  it('servers: list needs ManageServers or ManageGrants, get needs ManageServers', async () => {
    const servers = bare(ServersService, 7);
    await expect(servers.list(user, 'all')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(servers.get(testActor('g', Capability.ManageGrants), 's1', 'all'))
      .rejects.toBeInstanceOf(ForbiddenException);
    const findAllDtos = vi.spyOn(servers, 'findAllDtos').mockResolvedValue([]);
    await expect(servers.list(testActor('g', Capability.ManageGrants), 'all')).resolves.toEqual([]);
    expect(findAllDtos).toHaveBeenCalled();
  });

  it('servers: scope=mine hides servers the user holds no grant for', async () => {
    const servers = bare(ServersService, 7);
    Object.assign((servers as unknown as { access: object }).access, {
      listAccessibleServers: vi.fn().mockResolvedValue(['s1']),
    });
    await expect(servers.get(user, 's2', 'mine')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('images: list needs ManageImages, get(scope=all) too', async () => {
    const images = bare(ImagesService, 8);
    await expect(images.list(user, 'all')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(images.get(user, 'i1', 'all')).rejects.toBeInstanceOf(ForbiddenException);
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
    await expect(performance.series(testActor('m', Capability.ManageServers), {}, 'all'))
      .rejects.toBeInstanceOf(ForbiddenException);
    const bindings = bare(HttpProxyBindingsService, 3);
    const pools = bare(HttpDomainPoolsService, 5);
    await expect(bindings.listBindings(user, 'all', true)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(pools.listPools(user, 'all')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('volumes: local needs ManageVolumes, shared needs ManageSharedVolumes, capacity needs ManageServers', async () => {
    const volumes = bare(LocalVolumesService, 8);
    const shared = bare(SharedVolumesService, 8);
    await expect(volumes.list(user, { scope: 'all' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(volumes.list(testActor('s', Capability.ManageSharedVolumes), { scope: 'all' }))
      .rejects.toBeInstanceOf(ForbiddenException);
    await expect(shared.list(testActor('v', Capability.ManageVolumes), { scope: 'all' }))
      .rejects.toBeInstanceOf(ForbiddenException);
    await expect(volumes.capacity(user, 's1', 'all')).rejects.toBeInstanceOf(ForbiddenException);
  });
});
