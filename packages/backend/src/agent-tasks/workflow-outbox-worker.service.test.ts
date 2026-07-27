import { describe, expect, it, vi } from 'vitest';
import { WorkflowOutboxWorkerService } from './workflow-outbox-worker.service.js';

describe('WorkflowOutboxWorkerService', () => {
  it('publishes and batch-completes a disposable PostgreSQL wake intent', async () => {
    const repository = {
      claimOutbox: vi.fn().mockResolvedValue([{
        id: '1',
        topic: 'dispatch',
        partitionKey: 'server-a',
        payload: { taskId: 'task-a' },
        claimToken: 'claim-a',
      }]),
      completeOutboxClaims: vi.fn().mockResolvedValue(1),
    };
    const redis = { publish: vi.fn().mockResolvedValue(true) };
    const worker = new WorkflowOutboxWorkerService(
      repository as never,
      undefined,
      redis as never,
    );
    await expect(worker.process()).resolves.toBe(1);
    expect(redis.publish).toHaveBeenCalledWith(
      'dispatch',
      JSON.stringify({ taskId: 'task-a' }),
    );
    expect(repository.completeOutboxClaims).toHaveBeenCalledWith([
      expect.objectContaining({ id: '1', claimToken: 'claim-a' }),
    ]);
  });

  it('completes a disposable wake after one attempt when Redis is unavailable', async () => {
    const repository = {
      claimOutbox: vi.fn().mockResolvedValue([{
        id: '2',
        topic: 'dispatch',
        partitionKey: 'server-a',
        payload: { taskId: 'task-a' },
        claimToken: 'claim-b',
      }]),
      completeOutboxClaims: vi.fn().mockResolvedValue(1),
    };
    const redis = { publish: vi.fn().mockResolvedValue(false) };
    const worker = new WorkflowOutboxWorkerService(
      repository as never,
      undefined,
      redis as never,
    );
    await expect(worker.process()).resolves.toBe(0);
    expect(redis.publish).toHaveBeenCalledOnce();
    expect(repository.completeOutboxClaims).toHaveBeenCalledOnce();
  });

  it('stops publishing after the first outage and batch-completes every hint', async () => {
    const claims = Array.from({ length: 64 }, (_, index) => ({
      id: String(index + 1),
      topic: 'dispatch',
      partitionKey: `server-${index}`,
      payload: { taskId: `task-${index}` },
      claimToken: `claim-${index}`,
    }));
    const repository = {
      claimOutbox: vi.fn().mockResolvedValue(claims),
      completeOutboxClaims: vi.fn().mockResolvedValue(64),
    };
    const redis = { publish: vi.fn().mockResolvedValue(false) };
    const worker = new WorkflowOutboxWorkerService(
      repository as never,
      undefined,
      redis as never,
    );

    await expect(worker.process()).resolves.toBe(0);
    expect(redis.publish).toHaveBeenCalledOnce();
    expect(repository.completeOutboxClaims).toHaveBeenCalledOnce();
    expect(repository.completeOutboxClaims).toHaveBeenCalledWith(claims);
  });

  it('waits for an in-flight batch during shutdown and rejects later polls', async () => {
    let releaseClaim!: (claims: []) => void;
    const claims = new Promise<[]>((resolve) => {
      releaseClaim = resolve;
    });
    const repository = {
      claimOutbox: vi.fn().mockReturnValue(claims),
      completeOutboxClaims: vi.fn().mockResolvedValue(0),
    };
    const worker = new WorkflowOutboxWorkerService(
      repository as never,
      undefined,
      { publish: vi.fn() } as never,
    );

    const processing = worker.process();
    await vi.waitFor(() => expect(repository.claimOutbox).toHaveBeenCalledOnce());
    let shutdownComplete = false;
    const shutdown = worker.onModuleDestroy().then(() => {
      shutdownComplete = true;
    });
    await Promise.resolve();
    expect(shutdownComplete).toBe(false);

    releaseClaim([]);
    await expect(processing).resolves.toBe(0);
    await shutdown;
    expect(shutdownComplete).toBe(true);
    await expect(worker.process()).resolves.toBe(0);
    expect(repository.claimOutbox).toHaveBeenCalledOnce();
  });
});
