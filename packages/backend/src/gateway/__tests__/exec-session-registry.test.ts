import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ExecSessionRegistry,
  MAX_EXEC_SESSIONS,
  MAX_EXEC_SESSIONS_PER_SERVER,
  MAX_EXEC_SESSIONS_PER_USER,
} from '../exec-session-registry.js';

describe('ExecSessionRegistry bounds and ownership', () => {
  let registry: ExecSessionRegistry;

  beforeEach(() => {
    registry = new ExecSessionRegistry();
  });

  it('allows a session to be claimed exactly once', () => {
    registry.register('session-a', info());
    expect(registry.claimForUser('session-a', 'user-a', vi.fn()))
      .toMatchObject({ userId: 'user-a', claimed: true });
    expect(registry.claimForUser('session-a', 'user-a', vi.fn())).toBeUndefined();
    registry.remove('session-a');
  });

  it('does not claim or revoke a session for the wrong user', () => {
    const closeClient = vi.fn();
    registry.register('session-a', info());

    expect(registry.claimForUser('session-a', 'attacker', closeClient)).toBeUndefined();
    expect(registry.get('session-a')).toMatchObject({ userId: 'user-a', claimed: false });
    expect(closeClient).not.toHaveBeenCalled();
    registry.remove('session-a');
  });

  it('rejects sessions beyond the per-user cap', () => {
    for (let index = 0; index < MAX_EXEC_SESSIONS_PER_USER; index += 1) {
      registry.register(`session-${index}`, info());
    }
    expect(() => registry.register('session-overflow', info())).toThrow('User exec session limit');
    for (let index = 0; index < MAX_EXEC_SESSIONS_PER_USER; index += 1) {
      registry.remove(`session-${index}`);
    }
  });

  it('rejects sessions beyond the per-server cap', () => {
    for (let index = 0; index < MAX_EXEC_SESSIONS_PER_SERVER; index += 1) {
      registry.register(`session-${index}`, { ...info(), userId: `user-${index}` });
    }
    expect(() => registry.register('session-overflow', {
      ...info(),
      userId: 'user-overflow',
    })).toThrow('Server exec session limit');
  });

  it('rejects sessions beyond the global cap', () => {
    for (let index = 0; index < MAX_EXEC_SESSIONS; index += 1) {
      registry.register(`session-${index}`, {
        ...info(),
        userId: `user-${index}`,
        serverId: `server-${Math.floor(index / MAX_EXEC_SESSIONS_PER_SERVER)}`,
      });
    }
    expect(() => registry.register('session-overflow', {
      ...info(),
      userId: 'user-overflow',
      serverId: 'server-overflow',
    })).toThrow('Global exec session limit');
  });

  it('refreshes only claimed sessions', () => {
    registry.register('session-a', info());
    expect(registry.touch('session-a')).toBe(false);
    registry.claimForUser('session-a', 'user-a', vi.fn());
    expect(registry.touch('session-a')).toBe(true);
    registry.remove('session-a');
  });

  it('closes every bounded session attached to a runtime before mutation', () => {
    const orphan = vi.fn();
    const closeClient = vi.fn();
    registry.setOrphanHandler(orphan);
    registry.register('session-a', info());
    registry.register('session-b', { ...info(), userId: 'user-b' });
    registry.claimForUser('session-a', 'user-a', closeClient);

    registry.closeByRuntime('runtime-a');

    expect(orphan).toHaveBeenCalledTimes(2);
    expect(closeClient).toHaveBeenCalledWith('Container runtime is changing');
    expect(registry.get('session-a')).toBeUndefined();
    expect(registry.get('session-b')).toBeUndefined();
  });

  it('can close browser ownership after commit without racing one-way Agent cleanup', () => {
    const orphan = vi.fn();
    const closeClient = vi.fn();
    registry.setOrphanHandler(orphan);
    registry.register('session-a', info());
    registry.claimForUser('session-a', 'user-a', closeClient);

    registry.closeByRuntime('runtime-a', false);

    expect(closeClient).toHaveBeenCalledWith('Container runtime is changing');
    expect(orphan).not.toHaveBeenCalled();
    expect(registry.get('session-a')).toBeUndefined();
  });

  it('clears claimed and unclaimed sessions for a disconnected server without notifying it', () => {
    const orphan = vi.fn();
    const closeClient = vi.fn();
    registry.setOrphanHandler(orphan);
    registry.register('claimed', info());
    registry.register('unclaimed', info());
    registry.register('other', { ...info(), serverId: 'server-b' });
    registry.claimForUser('claimed', 'user-a', closeClient);

    registry.clearServer('server-a', false);

    expect(registry.get('claimed')).toBeUndefined();
    expect(registry.get('unclaimed')).toBeUndefined();
    expect(registry.get('other')).toBeDefined();
    expect(closeClient).toHaveBeenCalledWith('Agent connection ended');
    expect(orphan).not.toHaveBeenCalled();
    registry.remove('other');
  });
});

function info() {
  return {
    serverId: 'server-a',
    userId: 'user-a',
    containerId: 'container-a',
    dockerId: 'runtime-a',
    authorizationKind: 'container-owner' as const,
    createdAt: Date.now(),
  };
}
