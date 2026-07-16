import { describe, expect, it, vi } from 'vitest';
import { AgentTaskKind, type BackendToAgentMessage } from '@nyabase/common';
import { AgentMessageRouter } from './task-router.js';

const PAYLOAD_HASH = 'a'.repeat(64);

describe('AgentMessageRouter', () => {
  it('keeps task execute/accepted messages out of direct RPC', async () => {
    const tasks = { execute: vi.fn(async () => undefined), accepted: vi.fn() };
    const direct = {
      handle: vi.fn(async () => undefined),
      waitForIdle: vi.fn().mockResolvedValue(undefined),
    };
    const router = new AgentMessageRouter(tasks as never, direct as never);
    await router.handle({
      ts: 1,
      kind: 'task.execute.v1',
      payload: {
        taskId: 'task-a', kind: AgentTaskKind.ContainerStart, payloadHash: PAYLOAD_HASH,
        payload: { containerId: 'container-a', runtimeId: 'runtime-a' },
      },
    });
    await router.handle({
      ts: 2,
      kind: 'task.accepted.v1',
      payload: { taskId: 'task-a', payloadHash: PAYLOAD_HASH },
    });
    await router.handle({ id: 'rpc-a', ts: 3, kind: 'selfCheck', payload: {} });

    expect(tasks.execute).toHaveBeenCalledTimes(1);
    expect(tasks.accepted).toHaveBeenCalledTimes(1);
    expect(direct.handle).toHaveBeenCalledTimes(1);
  });

  it('rejects legacy fields through strict task parsing', async () => {
    const router = new AgentMessageRouter(
      { execute: vi.fn(), accepted: vi.fn() } as never,
      { handle: vi.fn(), waitForIdle: vi.fn().mockResolvedValue(undefined) } as never,
    );
    await expect(router.handle({
      ts: 1,
      kind: 'task.execute.v1',
      payload: {
        taskId: 'task-a', kind: AgentTaskKind.ContainerStart, payloadHash: PAYLOAD_HASH, payload: {},
        serverId: 'untrusted-server',
      },
    } as BackendToAgentMessage)).rejects.toThrow();
  });

  it('does not let a lifecycle task overtake an earlier exec close barrier', async () => {
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    let closeRegistered = false;
    const tasks = { execute: vi.fn(async () => undefined), accepted: vi.fn() };
    const direct = {
      handle: vi.fn(async (message: BackendToAgentMessage) => {
        if (message.kind !== 'execClose') return;
        closeRegistered = true;
        await closeGate;
      }),
      waitForIdle: vi.fn(async () => {
        if (closeRegistered) await closeGate;
      }),
    };
    const router = new AgentMessageRouter(tasks as never, direct as never);

    const close = router.handle({
      id: 'close-a', ts: 1, kind: 'execClose', payload: { sessionId: 'session-a' },
    });
    const task = router.handle({
      ts: 2,
      kind: 'task.execute.v1',
      payload: {
        taskId: 'task-a', kind: AgentTaskKind.ContainerStart, payloadHash: PAYLOAD_HASH,
        payload: { containerId: 'container-a', runtimeId: 'runtime-a' },
      },
    });
    await Promise.resolve();

    expect(closeRegistered).toBe(true);
    expect(tasks.execute).not.toHaveBeenCalled();
    releaseClose();
    await Promise.all([close, task]);
    expect(tasks.execute).toHaveBeenCalledOnce();
  });

  it('still executes execClose when physical-environment admission fails', async () => {
    const direct = {
      handle: vi.fn().mockResolvedValue(undefined),
      waitForIdle: vi.fn().mockResolvedValue(undefined),
    };
    const assertPhysicalEnvironment = vi.fn(() => { throw new Error('storage identity drift'); });
    const router = new AgentMessageRouter(
      { execute: vi.fn(), accepted: vi.fn() } as never,
      direct as never,
      assertPhysicalEnvironment,
    );

    await expect(router.handle({
      id: 'close-a', ts: 1, kind: 'execClose', payload: { sessionId: 'session-a' },
    })).resolves.toBeUndefined();
    expect(assertPhysicalEnvironment).not.toHaveBeenCalled();
    expect(direct.handle).toHaveBeenCalledOnce();
  });

  it('does not let bootstrap overtake ordered physical work', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tasks = {
      execute: vi.fn(),
      accepted: vi.fn(),
      waitForIdle: vi.fn(async () => gate),
    };
    const direct = {
      handle: vi.fn(async () => undefined),
      waitForIdle: vi.fn().mockResolvedValue(undefined),
    };
    const router = new AgentMessageRouter(tasks as never, direct as never);

    const bootstrap = router.handle({
      ts: 1,
      kind: 'agent.bootstrap.v1',
      payload: { remoteFsMounts: [] },
    });
    await vi.waitFor(() => expect(tasks.waitForIdle).toHaveBeenCalledOnce());

    expect(direct.handle).not.toHaveBeenCalled();
    release();
    await bootstrap;
    expect(direct.handle).toHaveBeenCalledOnce();
  });

  it('serializes bootstraps across reconnects so the newest snapshot wins and reconcile cannot overtake', async () => {
    let releaseOld!: () => void;
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
    const order: string[] = [];
    let activeSnapshot = '';
    const tasks = {
      execute: vi.fn(),
      accepted: vi.fn(),
      waitForIdle: vi.fn().mockResolvedValue(undefined),
    };
    const direct = {
      waitForIdle: vi.fn().mockResolvedValue(undefined),
      handle: vi.fn(async (message: BackendToAgentMessage) => {
        if (message.kind === 'agent.bootstrap.v1') {
          const id = (message.payload as { remoteFsMounts: Array<{ id: string }> }).remoteFsMounts[0]!.id;
          order.push(`${id}:start`);
          if (id === 'old-a') await oldGate;
          activeSnapshot = id;
          order.push(`${id}:applied`);
          return;
        }
        order.push('reconcile');
      }),
    };
    const router = new AgentMessageRouter(tasks as never, direct as never);
    const oldBootstrap = router.handle({
      ts: 1,
      kind: 'agent.bootstrap.v1',
      payload: { remoteFsMounts: [{ id: 'old-a' }] },
    } as BackendToAgentMessage);
    await vi.waitFor(() => expect(order).toEqual(['old-a:start']));

    const newBootstrap = router.handle({
      ts: 2,
      kind: 'agent.bootstrap.v1',
      payload: { remoteFsMounts: [{ id: 'new-b' }] },
    } as BackendToAgentMessage);
    const reconcile = router.handle({
      id: 'reconcile-new', ts: 3, kind: 'reconcile', payload: { serverId: 'server-a' },
    });
    await Promise.resolve();
    expect(order).toEqual(['old-a:start']);

    releaseOld();
    await Promise.all([oldBootstrap, newBootstrap, reconcile]);

    expect(activeSnapshot).toBe('new-b');
    expect(order).toEqual([
      'old-a:start',
      'old-a:applied',
      'new-b:start',
      'new-b:applied',
      'reconcile',
    ]);
  });
});
