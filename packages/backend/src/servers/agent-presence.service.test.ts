import { describe, expect, it, vi } from 'vitest';
import type { AgentHello } from '@nyabase/common';
import type { AgentPresenceListener } from '../incus/agent-registry.service.js';
import { AgentPresenceService } from './agent-presence.service.js';

const SERVER_ID = '11111111-1111-4111-8111-111111111111';
const HELLO: AgentHello = {
  type: 'hello',
  protocol: 1,
  agentVersion: '0.1.0',
  hostname: 'worker',
  incus: { serverVersion: '7.4', apiExtensions: [] },
};

function harness() {
  const updates: Array<{ values: Record<string, unknown>; where: unknown[][] }> = [];
  const database = {
    updateTable: vi.fn(() => {
      const entry = { values: {} as Record<string, unknown>, where: [] as unknown[][] };
      const builder = {
        set: vi.fn((values: Record<string, unknown>) => {
          entry.values = values;
          return builder;
        }),
        where: vi.fn((...args: unknown[]) => {
          entry.where.push(args);
          return builder;
        }),
        execute: vi.fn(async () => {
          updates.push(entry);
          return [];
        }),
      };
      return builder;
    }),
  };
  let listener!: AgentPresenceListener;
  let connected = false;
  const agents = {
    onPresence: vi.fn((value: AgentPresenceListener) => {
      listener = value;
      return () => undefined;
    }),
    isConnected: vi.fn(() => connected),
  };
  const health = { refreshInventory: vi.fn().mockResolvedValue(undefined) };
  const wake = { wake: vi.fn() };
  const service = new AgentPresenceService(
    database as never,
    agents as never,
    { get: vi.fn().mockResolvedValue({}) } as never,
    health as never,
    wake as never,
  );
  service.onModuleInit();
  return {
    service,
    updates,
    health,
    setConnected: (value: boolean) => {
      connected = value;
    },
    listener: () => listener,
  };
}

describe('AgentPresenceService', () => {
  it('forgets the online status a previous process left behind', async () => {
    const h = harness();
    await h.service.onApplicationBootstrap();
    expect(h.updates).toEqual([{
      values: { status: 'unreachable', last_error: 'Waiting for the server agent to connect' },
      where: [['status', '=', 'online']],
    }]);
  });

  it('applies connect and disconnect in order and never leaves a gone agent online', async () => {
    const h = harness();
    h.setConnected(false);
    // The agent connected and dropped before the connect projection ran.
    const up = h.listener().connected(SERVER_ID, HELLO);
    const down = h.listener().disconnected(SERVER_ID);
    await Promise.all([up, down]);
    expect(h.updates.map((update) => update.values.status)).toEqual(['unreachable']);
    expect(h.health.refreshInventory).not.toHaveBeenCalled();

    h.setConnected(true);
    await h.listener().connected(SERVER_ID, HELLO);
    expect(h.updates.at(-1)?.values.status).toBe('online');
    expect(h.health.refreshInventory).toHaveBeenCalledTimes(1);
  });
});
