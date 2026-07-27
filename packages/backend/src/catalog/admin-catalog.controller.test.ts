import { describe, expect, it, vi } from 'vitest';
import { AdminCatalogController } from './admin-catalog.controller.js';
import { Capability } from '@nyabase/common';
import { ANY_CAPS_KEY } from '../auth/decorators/require-caps.decorator.js';

describe('AdminCatalogController', () => {
  it('projects 4096 user selector rows from one bulk persistence call', async () => {
    const { controller, persistence } = makeController();
    persistence.listUsers.mockResolvedValue(Array.from({ length: 4_096 }, (_, index) => ({
      id: `user-${index}`,
      username: `user-${index}`,
      display_name: `User ${index}`,
      status: 'active',
    })));
    await expect(controller.listUsers()).resolves.toHaveLength(4_096);
    expect(persistence.listUsers).toHaveBeenCalledOnce();
  });

  it('returns purpose-safe user and group selector records', async () => {
    const { controller, persistence } = makeController();
    persistence.listUsers.mockResolvedValue([{
      id: 'user-a',
      username: 'alice',
      display_name: 'Alice',
      status: 'active',
      passwordHash: 'must-not-leak',
      authVersion: 7,
    }]);
    persistence.listGroups.mockResolvedValue([{
      id: 'group-a',
      name: 'Operators',
      description: null,
      priority: 10,
      is_system: false,
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
    const { controller, persistence, agentGateway } = makeController();
    persistence.listServers.mockResolvedValue([{
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
    const { controller, persistence } = makeController();
    persistence.listActiveRemoteFsMounts.mockResolvedValue([{
      id: 'mount-a',
      name: 'dataset',
      displayName: 'Dataset',
      serverIds: ['server-a', 'server-b'],
    }]);

    await expect(controller.listGrantRemoteFsMounts()).resolves.toEqual([{
      id: 'mount-a',
      name: 'dataset',
      displayName: 'Dataset',
      serverIds: ['server-a', 'server-b'],
    }]);
  });
});

function makeController() {
  const persistence = {
    listUsers: vi.fn(),
    listGroups: vi.fn(),
    listServers: vi.fn(),
    listActiveImages: vi.fn(),
    listActiveRemoteFsMounts: vi.fn(),
  };
  const agentGateway = { stateCache: { get: vi.fn() } };
  const accessResolver = { administrationActionsCurrent: vi.fn() };
  return {
    persistence,
    agentGateway,
    accessResolver,
    controller: new AdminCatalogController(
      persistence as never,
      agentGateway as never,
      accessResolver as never,
    ),
  };
}
