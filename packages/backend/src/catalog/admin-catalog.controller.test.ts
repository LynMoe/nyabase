import { describe, expect, it, vi } from 'vitest';
import { AdminCatalogController } from './admin-catalog.controller.js';
import { Capability } from '@nyabase/common';
import { ANY_CAPS_KEY } from '../auth/decorators/require-caps.decorator.js';

describe('AdminCatalogController', () => {
  it('returns purpose-safe user and group selector records', async () => {
    const { controller, users, groups } = makeController();
    users.find.mockResolvedValue([{
      id: 'user-a',
      username: 'alice',
      displayName: 'Alice',
      status: 'active',
      passwordHash: 'must-not-leak',
      authVersion: 7,
    }]);
    groups.find.mockResolvedValue([{
      id: 'group-a',
      name: 'Operators',
      description: null,
      priority: 10,
      isSystem: false,
      capabilities: ['manage_grants'],
      capabilitiesJson: '["manage_grants"]',
    }]);

    await expect(controller.listUsers()).resolves.toEqual([{
      id: 'user-a', username: 'alice', displayName: 'Alice', status: 'active',
    }]);
    await expect(controller.listGroups()).resolves.toEqual([{
      id: 'group-a',
      name: 'Operators',
      isSystem: false,
    }]);
  });

  it('delegates action availability to the current durable authority projection', async () => {
    const { controller, accessResolver } = makeController();
    const projection = { createUser: { allowed: false } };
    accessResolver.administrationActionsCurrent.mockResolvedValue(projection);
    await expect(controller.administrationActions({ id: 'actor-a' } as never)).resolves.toBe(projection);
    expect(accessResolver.administrationActionsCurrent).toHaveBeenCalledWith('actor-a');
  });

  it('admits only user/group administrators to the target-sensitive action projection', () => {
    const requiredAny = Reflect.getMetadata(
      ANY_CAPS_KEY,
      AdminCatalogController.prototype.administrationActions,
    );
    expect(requiredAny).toEqual([Capability.ManageUsers, Capability.ManageGroups]);
    expect(requiredAny).not.toContain(Capability.ManageGrants);
  });

  it('never exposes full Server administration fields to grant or metric selectors', async () => {
    const { controller, servers, agentGateway } = makeController();
    servers.find.mockResolvedValue([{
      id: 'server-a',
      name: 'Node A',
      slug: 'node-a',
      status: 'online',
      hostFingerprint: 'secret-host-identity',
      disks: [{ diskId: 'disk-a', mountPoint: '/sensitive/path' }],
    }]);
    agentGateway.stateCache.get.mockReturnValue({
      runtimeReady: true,
      gpus: [{ index: 0, model: 'GPU 0', totalMemMiB: 24_576, uuid: 'GPU-secret-uuid' }],
    });

    await expect(controller.listGrantServers()).resolves.toEqual([{
      id: 'server-a',
      name: 'Node A',
      slug: 'node-a',
      status: 'online',
      runtimeReady: true,
      gpus: [{ index: 0, model: 'GPU 0', totalMemMiB: 24_576 }],
    }]);
    await expect(controller.listMetricServers()).resolves.toEqual([{
      id: 'server-a',
      name: 'Node A',
      slug: 'node-a',
      status: 'online',
      runtimeReady: true,
      hasGpu: true,
    }]);
  });

  it('returns only active remote mount assignments without secret params', async () => {
    const { controller, remoteFsMounts, remoteFsAssignments } = makeController();
    remoteFsMounts.find.mockResolvedValue([{
      id: 'mount-a',
      name: 'dataset',
      displayName: 'Dataset',
      params: { secret: 'must-not-leak' },
    }]);
    remoteFsAssignments.find.mockResolvedValue([
      { remoteFsMountId: 'mount-a', serverId: 'server-b' },
      { remoteFsMountId: 'mount-a', serverId: 'server-a' },
    ]);

    await expect(controller.listGrantRemoteFsMounts()).resolves.toEqual([{
      id: 'mount-a',
      name: 'dataset',
      displayName: 'Dataset',
      serverIds: ['server-a', 'server-b'],
    }]);
  });
});

function makeController() {
  const users = { find: vi.fn() };
  const groups = { find: vi.fn() };
  const images = { find: vi.fn() };
  const remoteFsMounts = { find: vi.fn() };
  const remoteFsAssignments = { find: vi.fn() };
  const servers = { find: vi.fn() };
  const agentGateway = { stateCache: { get: vi.fn() } };
  const accessResolver = { administrationActionsCurrent: vi.fn() };
  return {
    users,
    groups,
    images,
    remoteFsMounts,
    remoteFsAssignments,
    servers,
    agentGateway,
    accessResolver,
    controller: new AdminCatalogController(
      users as never,
      groups as never,
      images as never,
      remoteFsMounts as never,
      remoteFsAssignments as never,
      servers as never,
      agentGateway as never,
      accessResolver as never,
    ),
  };
}
