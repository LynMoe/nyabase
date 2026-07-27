import { describe, expect, it, vi } from 'vitest';
import { AgentTaskDispatcherService } from './agent-task-dispatcher.service.js';
import { AgentTaskRetentionService } from './agent-task-retention.service.js';
import { WorkflowFinalizerWorkerService } from './workflow-finalizer-worker.service.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const workerRole = {
  runsWorker: () => true,
  servesGateway: () => false,
};
const gatewayRole = {
  runsWorker: () => false,
  servesGateway: () => true,
};

describe('PostgreSQL worker lifecycle fences', () => {
  it('drains a blocked retention pass and rejects late wakes after shutdown', async () => {
    const blocked = deferred<number>();
    const purge = vi.fn().mockReturnValueOnce(blocked.promise);
    const service = new AgentTaskRetentionService(
      { purgeTerminalRetention: purge } as never,
      workerRole as never,
    );

    const pass = service.process();
    await vi.waitFor(() => expect(purge).toHaveBeenCalledOnce());
    const destroy = service.onModuleDestroy();
    let destroyed = false;
    void destroy.then(() => { destroyed = true; });
    await Promise.resolve();
    expect(destroyed).toBe(false);
    service.wake();
    blocked.resolve(0);
    await expect(pass).resolves.toEqual({ scanned: 0, deleted: 0 });
    await destroy;
    await expect(service.process()).resolves.toEqual({ scanned: 0, deleted: 0 });
    expect(purge).toHaveBeenCalledOnce();
  });

  it('contains finalizer claim rejection and drains a blocked claim on destroy', async () => {
    const blocked = deferred<never[]>();
    const claimFinalizers = vi.fn()
      .mockRejectedValueOnce(new Error('postgres unavailable'))
      .mockReturnValueOnce(blocked.promise);
    const service = new WorkflowFinalizerWorkerService(
      { claimFinalizers } as never,
      { get: vi.fn() } as never,
      workerRole as never,
    );

    await expect(service.process()).resolves.toBe(0);
    const pass = service.process();
    await vi.waitFor(() => expect(claimFinalizers).toHaveBeenCalledTimes(2));
    const destroy = service.onModuleDestroy();
    blocked.resolve([]);
    await expect(pass).resolves.toBe(0);
    await destroy;
    service.wake();
    await expect(service.process()).resolves.toBe(0);
    expect(claimFinalizers).toHaveBeenCalledTimes(2);
  });

  it('contains dispatcher rejection and awaits one in-flight dispatch before teardown', async () => {
    const blocked = deferred<null>();
    const claimAndBuild = vi.fn()
      .mockRejectedValueOnce(new Error('postgres unavailable'))
      .mockReturnValueOnce(blocked.promise);
    const service = new AgentTaskDispatcherService(
      gatewayRole as never,
      {} as never,
      { claimAndBuild } as never,
    );
    (service as unknown as { transport: unknown }).transport = {
      onlineSessions: () => [{ serverId: 'server-a', session: {} }],
      send: vi.fn(),
    };

    await expect(service.process()).resolves.toBe(0);
    const pass = service.process();
    await vi.waitFor(() => expect(claimAndBuild).toHaveBeenCalledTimes(2));
    const destroy = service.onModuleDestroy();
    blocked.resolve(null);
    await expect(pass).resolves.toBe(0);
    await destroy;
    service.wake();
    await expect(service.process()).resolves.toBe(0);
    expect(claimAndBuild).toHaveBeenCalledTimes(2);
  });
});
