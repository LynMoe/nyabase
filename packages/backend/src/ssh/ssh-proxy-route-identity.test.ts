import { describe, expect, it } from 'vitest';
import {
  ContainerStatus,
  ServerStatus,
  UserStatus,
  resolveSshProxyRoute,
} from '@nyabase/common';

describe('SSH proxy routed identity', () => {
  it('resolves only the Incus instance name and routed IP identity', () => {
    const snapshot = {
      users: [{
        id: 'user-1',
        username: 'alice',
        status: UserStatus.Active,
        publicKeys: ['ssh-ed25519 AAAAkey'],
      }],
      servers: [{
        id: 'server-1',
        slug: 'node-a',
        name: 'Node A',
        status: ServerStatus.Online,
      }],
      images: [{ id: 'image-1', sshEnabled: true }],
      containers: [{
        id: 'container-1',
        ownerId: 'user-1',
        serverId: 'server-1',
        imageId: 'image-1',
        name: 'web',
        instanceName: 'nyc-container-1',
      }],
      routes: [{
        containerId: 'container-1',
        serverId: 'server-1',
        instanceName: 'nyc-container-1',
        routedIp: '10.20.0.42',
        status: ContainerStatus.Running,
        sshStatus: 'running' as const,
        observedAt: new Date().toISOString(),
      }],
    };

    const resolved = resolveSshProxyRoute(snapshot, 'alice.node-a.web');
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.route).toMatchObject({
        instanceName: 'nyc-container-1',
        routedIp: '10.20.0.42',
      });
      expect(resolved.route).not.toHaveProperty('macvlanIp');
      expect(resolved.route).not.toHaveProperty('runtimeId');
    }
  });
});
