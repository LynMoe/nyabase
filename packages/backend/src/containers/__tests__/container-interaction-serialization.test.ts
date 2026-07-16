import { describe, expect, it, vi } from 'vitest';
import { ContainerControlService } from '../container-control.service.js';

type InteractionRunner = {
  runContainerInteraction<T>(containerId: string, work: () => Promise<T>): Promise<T>;
};

type LifecycleCommitRunner = {
  enqueueLifecycleTaskThenRevokeConsoles(
    runtimeId: string | null,
    enqueue: () => Promise<{ taskId: string; status: 'pending' }>,
  ): Promise<{ taskId: string; status: 'pending' }>;
};

function runner(): InteractionRunner {
  const service = Object.create(ContainerControlService.prototype) as ContainerControlService;
  Object.defineProperty(service, 'activeContainerInteractions', { value: new Set() });
  return service as unknown as InteractionRunner;
}

describe('container console/task interaction serialization', () => {
  it('never revokes a console before its lifecycle task transaction commits', async () => {
    const service = Object.create(ContainerControlService.prototype) as ContainerControlService;
    const closeByRuntime = vi.fn();
    Object.defineProperty(service, 'execSessionRegistry', { value: { closeByRuntime } });
    const commit = service as unknown as LifecycleCommitRunner;

    await expect(commit.enqueueLifecycleTaskThenRevokeConsoles(
      'runtime-a',
      async () => { throw new Error('transaction rolled back'); },
    )).rejects.toThrow('transaction rolled back');
    expect(closeByRuntime).not.toHaveBeenCalled();

    await expect(commit.enqueueLifecycleTaskThenRevokeConsoles(
      'runtime-a',
      async () => ({ taskId: 'task-a', status: 'pending' }),
    )).resolves.toEqual({ taskId: 'task-a', status: 'pending' });
    expect(closeByRuntime).toHaveBeenCalledWith('runtime-a', true);
  });

  it('fails a console RPC fast while a lifecycle action for the same container is open', async () => {
    const interactions = runner();
    let releaseAction!: () => void;
    const actionGate = new Promise<void>((resolve) => { releaseAction = resolve; });
    const order: string[] = [];

    const action = interactions.runContainerInteraction('container-a', async () => {
      order.push('action:start');
      await actionGate;
      order.push('action:commit');
    });
    await vi.waitFor(() => expect(order).toEqual(['action:start']));

    const consoleRpc = interactions.runContainerInteraction('container-a', async () => {
      order.push('console:rpc');
    });

    await expect(consoleRpc).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'CONTAINER_INTERACTION_BUSY' }),
    });
    expect(order).toEqual(['action:start']);
    releaseAction();
    await action;

    await interactions.runContainerInteraction('container-a', async () => {
      order.push('console:rpc');
    });
    expect(order).toEqual(['action:start', 'action:commit', 'console:rpc']);
  });

  it('releases the busy guard after a failed interaction', async () => {
    const interactions = runner();
    const first = interactions.runContainerInteraction('container-a', async () => {
      throw new Error('rejected action');
    });

    await expect(first).rejects.toThrow('rejected action');
    const next = interactions.runContainerInteraction('container-a', async () => 'console-ready');
    await expect(next).resolves.toBe('console-ready');
  });
});
