import { describe, expect, it, vi } from 'vitest';
import type { AccessResolverService } from '../access/access-resolver.service.js';
import type { UserRecord } from '../domain/domain-records.js';
import type { AgentGateway } from '../gateway/agent-gateway.js';
import { AdminServersController } from './admin-servers.controller.js';
import { ServersController } from './servers.controller.js';
import type { ServersService } from './servers.service.js';

describe('Server controller identity projection', () => {
  it('requests host identity only from the administrator list and detail routes', async () => {
    const findAllDtos = vi.fn().mockResolvedValue([]);
    const findDtoById = vi.fn().mockResolvedValue({ id: 'server-a' });
    const controller = new AdminServersController({
      findAllDtos,
      findDtoById,
    } as unknown as ServersService);

    await controller.list();
    await controller.get('server-a');

    expect(findAllDtos).toHaveBeenCalledWith({ includeHostFingerprint: true });
    expect(findDtoById).toHaveBeenCalledWith('server-a', {
      includeHostFingerprint: true,
    });
  });

  it('keeps the ordinary-user list and detail routes on the public projection', async () => {
    const findUserDtosByIds = vi.fn().mockResolvedValue([]);
    const findUserDtoById = vi.fn().mockResolvedValue({ id: 'server-a' });
    const service = { findUserDtosByIds, findUserDtoById } as unknown as ServersService;
    const access = {
      listAccessibleServers: vi.fn().mockResolvedValue(['server-a']),
    } as unknown as AccessResolverService;
    const controller = new ServersController(service, access, {} as AgentGateway);
    const user = { id: 'user-a' } as UserRecord;

    await controller.list(user);
    await controller.get('server-a', user);

    expect(findUserDtosByIds).toHaveBeenCalledWith(['server-a']);
    expect(findUserDtoById).toHaveBeenCalledWith('server-a');
  });

  it('passes the authenticated actor through every audited server mutation', async () => {
    const create = vi.fn().mockResolvedValue({
      server: { id: 'server-a' },
      agentToken: 'returned-once',
    });
    const update = vi.fn().mockResolvedValue({ id: 'server-a' });
    const deleteServer = vi.fn().mockResolvedValue(undefined);
    const regenerateToken = vi.fn().mockResolvedValue('returned-once');
    const selfCheck = vi.fn().mockResolvedValue({ ok: true });
    const controller = new AdminServersController({
      create,
      update,
      delete: deleteServer,
      regenerateToken,
      selfCheck,
    } as unknown as ServersService);
    const actor = { id: 'actor-a' } as UserRecord;

    await controller.create(actor, { name: 'Server A', slug: 'server-a' });
    await controller.update('server-a', actor, { name: 'Renamed' });
    await controller.delete('server-a', actor);
    await controller.regenerateToken('server-a', actor);
    await controller.selfCheck('server-a', actor);

    expect(create).toHaveBeenCalledWith('actor-a', { name: 'Server A', slug: 'server-a' });
    expect(update).toHaveBeenCalledWith('actor-a', 'server-a', { name: 'Renamed' });
    expect(deleteServer).toHaveBeenCalledWith('actor-a', 'server-a');
    expect(regenerateToken).toHaveBeenCalledWith('actor-a', 'server-a');
    expect(selfCheck).toHaveBeenCalledWith('actor-a', 'server-a');
  });
});
