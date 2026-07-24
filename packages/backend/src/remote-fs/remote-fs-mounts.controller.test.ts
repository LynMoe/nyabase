import { RemoteFsType } from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';
import type { UserEntity } from '../entities/user.entity.js';
import { RemoteFsMountsController } from './remote-fs-mounts.controller.js';
import type { RemoteFsMountsService } from './remote-fs-mounts.service.js';

describe('RemoteFsMountsController request identities', () => {
  it('rejects every invalid route/query identity before repository or task work', async () => {
    const service = serviceMock();
    const controller = new RemoteFsMountsController(service as unknown as RemoteFsMountsService);
    const actor = { id: 'admin-a' } as UserEntity;
    const invalid = '../escape';

    await expect(controller.list(invalid)).rejects.toBeDefined();
    await expect(controller.get(invalid)).rejects.toBeDefined();
    await expect(controller.update(invalid, { name: 'safe' }, actor)).rejects.toBeDefined();
    await expect(controller.remove(invalid, actor)).rejects.toBeDefined();
    await expect(controller.listServers(invalid)).rejects.toBeDefined();
    await expect(controller.assignServer(invalid, { serverId: 'server-a' }, actor)).rejects.toBeDefined();
    await expect(controller.assignServer('mount-a', { serverId: invalid }, actor)).rejects.toBeDefined();
    await expect(controller.unassignServer('mount-a', invalid, actor)).rejects.toBeDefined();
    await expect(controller.create({
      name: 'safe',
      serverIds: [invalid],
      params: {
        type: RemoteFsType.Nfs,
        nfsServer: 'storage.example.test',
        exportPath: '/exports/data',
        version: '4.2',
      },
    }, actor)).rejects.toBeDefined();

    for (const operation of Object.values(service)) expect(operation).not.toHaveBeenCalled();
  });

  it('rejects overlong identities as well as path-shaped values', async () => {
    const service = serviceMock();
    const controller = new RemoteFsMountsController(service as unknown as RemoteFsMountsService);
    await expect(controller.get('x'.repeat(129))).rejects.toBeDefined();
    await expect(controller.list('x'.repeat(129))).rejects.toBeDefined();
    for (const operation of Object.values(service)) expect(operation).not.toHaveBeenCalled();
  });

  it('rejects an impossible Ceph monitor port before persistence or task work', async () => {
    const service = serviceMock();
    const controller = new RemoteFsMountsController(service as unknown as RemoteFsMountsService);
    await expect(controller.create({
      name: 'ceph-a',
      params: {
        type: RemoteFsType.CephFs,
        monHosts: 'node-a:99999',
        exportPath: '/',
        clientName: 'admin',
        secret: 'AQAB==',
      },
    }, { id: 'admin-a' } as UserEntity)).rejects.toBeDefined();
    for (const operation of Object.values(service)) expect(operation).not.toHaveBeenCalled();
  });
});

function serviceMock() {
  return {
    list: vi.fn(),
    findById: vi.fn(),
    getServerIds: vi.fn(),
    getMountStatuses: vi.fn(),
    toDto: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    listServerAssignments: vi.fn(),
    assignServer: vi.fn(),
    unassignServer: vi.fn(),
  };
}
