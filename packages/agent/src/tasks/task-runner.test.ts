import { describe, expect, it, vi } from 'vitest';
import {
  AgentTaskKind,
  canonicalJson,
  MAX_AGENT_TASK_RESULT_BYTES,
  RemoteFsType,
  type TaskExecutePayload,
  type TaskResultPayload,
} from '@nyabase/common';
import { createHash } from 'crypto';
import {
  AgentTaskHandlerRegistry,
  IncompleteTaskError,
  ManagedTaskError,
  type AgentTaskHandler,
} from './task-handler.js';
import {
  AgentTaskRunner,
  MAX_TRACKED_TASKS,
  TaskIdentityConflictError,
} from './task-runner.js';

const taskPayload: TaskExecutePayload['payload'] = {
  id: 'remote-a',
  hostMountPoint: '/mnt/remote-fs/remote-a',
  options: 'rw',
  params: {
    type: RemoteFsType.Nfs,
    nfsServer: '10.0.0.1',
    exportPath: '/project',
    version: '4.2',
  },
};

const task: TaskExecutePayload = {
  taskId: 'task-a',
  kind: AgentTaskKind.RemoteFsEnsure,
  payloadHash: wireHash(AgentTaskKind.RemoteFsEnsure, taskPayload),
  payload: taskPayload,
};

describe('AgentTaskRunner', () => {
  it('runs the transient exec-close barrier only after schema/hash validation and before the handler', async () => {
    let release!: () => void;
    const closeGate = new Promise<void>((resolve) => { release = resolve; });
    const ensure = vi.fn(async () => ({ mounted: true }));
    const releaseLease = vi.fn();
    const beforePhysicalTask = vi.fn(async () => {
      await closeGate;
      return releaseLease;
    });
    const sent: TaskResultPayload[] = [];
    const runner = new AgentTaskRunner(
      new AgentTaskHandlerRegistry([{
        kinds: [AgentTaskKind.RemoteFsEnsure],
        ensure,
        verify: vi.fn(async () => undefined),
      }]),
      (result) => sent.push(result),
      vi.fn(),
      beforePhysicalTask,
    );

    const execution = runner.execute(task);
    await vi.waitFor(() => expect(beforePhysicalTask).toHaveBeenCalledOnce());
    expect(ensure).not.toHaveBeenCalled();
    expect(releaseLease).not.toHaveBeenCalled();
    release();
    await execution;
    expect(ensure).toHaveBeenCalledOnce();
    expect(releaseLease).toHaveBeenCalledOnce();
    expect(sent.at(-1)).toMatchObject({ status: 'succeeded' });

    const corrupt = { ...task, taskId: 'task-corrupt', payloadHash: 'b'.repeat(64) };
    await runner.execute(corrupt);
    expect(beforePhysicalTask).toHaveBeenCalledOnce();
    expect(sent.at(-1)).toMatchObject({
      taskId: 'task-corrupt',
      status: 'failed',
      error: { code: 'task_payload_hash_mismatch' },
    });
  });

  it('closes a hash-verified runtime before environment failure and always releases the fence', async () => {
    const beforePhysicalTask = vi.fn().mockResolvedValue(vi.fn());
    const releaseLease = vi.fn();
    beforePhysicalTask.mockResolvedValue(releaseLease);
    const ensure = vi.fn();
    const sent: TaskResultPayload[] = [];
    const runner = new AgentTaskRunner(
      new AgentTaskHandlerRegistry([{
        kinds: [AgentTaskKind.RemoteFsEnsure],
        ensure,
        verify: vi.fn(),
      }]),
      (result) => sent.push(result),
      () => { throw new Error('storage identity drift'); },
      beforePhysicalTask,
    );

    await runner.execute(task);

    expect(beforePhysicalTask).toHaveBeenCalledOnce();
    expect(ensure).not.toHaveBeenCalled();
    expect(releaseLease).toHaveBeenCalledOnce();
    expect(sent.at(-1)).toMatchObject({
      status: 'incomplete',
      error: { code: 'agent_task_incomplete', message: 'storage identity drift' },
    });
  });

  it('holds one runtime lease across duplicate delivery until the original handler settles', async () => {
    let releaseHandler!: () => void;
    const handlerGate = new Promise<void>((resolve) => { releaseHandler = resolve; });
    const releaseLease = vi.fn();
    const beforePhysicalTask = vi.fn().mockResolvedValue(releaseLease);
    const ensure = vi.fn(async () => {
      await handlerGate;
      return { mounted: true };
    });
    const runner = new AgentTaskRunner(
      new AgentTaskHandlerRegistry([{
        kinds: [AgentTaskKind.RemoteFsEnsure], ensure, verify: vi.fn(),
      }]),
      vi.fn(),
      vi.fn(),
      beforePhysicalTask,
    );

    const first = runner.execute(task);
    const duplicate = runner.execute(task);
    await vi.waitFor(() => expect(ensure).toHaveBeenCalledOnce());
    expect(beforePhysicalTask).toHaveBeenCalledOnce();
    expect(releaseLease).not.toHaveBeenCalled();

    releaseHandler();
    await Promise.all([first, duplicate]);
    expect(beforePhysicalTask).toHaveBeenCalledOnce();
    expect(releaseLease).toHaveBeenCalledOnce();
  });

  it('finishes a delayed report send before a later physical task and result', async () => {
    let releaseReport!: () => void;
    const reportGate = new Promise<void>((resolve) => { releaseReport = resolve; });
    const order: string[] = [];
    const ensure = vi.fn(async () => {
      order.push('task:physical');
      return { mounted: true };
    });
    const runner = new AgentTaskRunner(
      new AgentTaskHandlerRegistry([{
        kinds: [AgentTaskKind.RemoteFsEnsure],
        ensure,
        verify: vi.fn(async () => undefined),
      }]),
      () => { order.push('task:result'); },
    );

    const report = runner.enqueueObservation('stateReport', async () => {
      order.push('report:collect');
      await reportGate;
      order.push('report:send');
    });
    const execution = runner.execute(task);

    await vi.waitFor(() => expect(order).toEqual(['report:collect']));
    expect(ensure).not.toHaveBeenCalled();
    releaseReport();
    await Promise.all([report, execution]);

    expect(order).toEqual([
      'report:collect',
      'report:send',
      'task:physical',
      'task:result',
    ]);
  });

  it('bounds each observation kind to one active and the latest follow-up', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const calls: string[] = [];
    const { runner } = makeRunner({
      kinds: [AgentTaskKind.RemoteFsEnsure],
      ensure: vi.fn(async () => null),
      verify: vi.fn(async () => undefined),
    });

    const first = runner.enqueueObservation('stateReport', async () => {
      calls.push('first');
      await firstGate;
    });
    await vi.waitFor(() => expect(calls).toEqual(['first']));

    const followUps = Array.from({ length: 1_000 }, (_, index) => vi.fn(async () => {
      calls.push(`follow-up:${index}`);
    }));
    const returned = followUps.map((work) => runner.enqueueObservation('stateReport', work));
    expect(returned.every((promise) => promise === first)).toBe(true);

    releaseFirst();
    await first;

    expect(calls).toEqual(['first', 'follow-up:999']);
    expect(followUps.slice(0, -1).every((work) => work.mock.calls.length === 0)).toBe(true);
    expect(followUps.at(-1)).toHaveBeenCalledOnce();
  });

  it('waitForIdle includes the latest coalesced observation', async () => {
    let releaseFirst!: () => void;
    let releaseLatest!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const latestGate = new Promise<void>((resolve) => { releaseLatest = resolve; });
    const calls: string[] = [];
    const { runner } = makeRunner({
      kinds: [AgentTaskKind.RemoteFsEnsure],
      ensure: vi.fn(async () => null),
      verify: vi.fn(async () => undefined),
    });
    void runner.enqueueObservation('stateReport', async () => {
      calls.push('first');
      await firstGate;
    });
    await vi.waitFor(() => expect(calls).toEqual(['first']));
    void runner.enqueueObservation('stateReport', async () => {
      calls.push('latest');
      await latestGate;
    });

    let idle = false;
    const waiting = runner.waitForIdle().then(() => { idle = true; });
    releaseFirst();
    await vi.waitFor(() => expect(calls).toEqual(['first', 'latest']));
    expect(idle).toBe(false);

    releaseLatest();
    await waiting;
    expect(idle).toBe(true);
  });

  it('deduplicates in-flight work and globally serializes different tasks', async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    const ensure = vi.fn(async (_kind: AgentTaskKind, payload: unknown) => {
      const id = (payload as { id: string }).id;
      order.push(`start:${id}`);
      if (id === 'remote-a') await barrier;
      order.push(`end:${id}`);
      return { id };
    });
    const { runner, sent } = makeRunner({
      kinds: [AgentTaskKind.RemoteFsEnsure],
      ensure,
      verify: vi.fn(async () => undefined),
    });
    const payloadB = { ...(task.payload as object), id: 'remote-b' };
    const taskB: TaskExecutePayload = {
      ...task,
      taskId: 'task-b',
      payloadHash: wireHash(task.kind, payloadB),
      payload: payloadB,
    };

    const first = runner.execute(task);
    const duplicate = runner.execute(task);
    const second = runner.execute(taskB);
    await vi.waitFor(() => expect(order).toEqual(['start:remote-a']));
    release();
    await Promise.all([first, duplicate, second]);

    expect(ensure).toHaveBeenCalledTimes(2);
    expect(order).toEqual([
      'start:remote-a', 'end:remote-a',
      'start:remote-b', 'end:remote-b',
    ]);
    expect(sent).toHaveLength(2);
  });

  it('keeps queued task payloads within the per-Agent capacity budget', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { runner, sent } = makeRunner({
      kinds: [AgentTaskKind.RemoteFsEnsure],
      ensure: vi.fn(async () => {
        await gate;
        return { mounted: true };
      }),
      verify: vi.fn(async () => undefined),
    });
    const accepted = Array.from({ length: MAX_TRACKED_TASKS }, (_, index) => {
      const payload = { ...(task.payload as object), id: `remote-${index}` };
      return runner.execute({
        ...task,
        taskId: `task-${index}`,
        payload,
        payloadHash: wireHash(task.kind, payload),
      });
    });
    const overflowPayload = { ...(task.payload as object), id: 'remote-overflow' };

    await runner.execute({
      ...task,
      taskId: 'task-overflow',
      payload: overflowPayload,
      payloadHash: wireHash(task.kind, overflowPayload),
    });

    expect(sent).toContainEqual(expect.objectContaining({
      taskId: 'task-overflow',
      status: 'incomplete',
      error: expect.objectContaining({ code: 'agent_task_capacity_reached' }),
    }));
    release();
    await Promise.all(accepted);
  });

  it('keeps retry fan-out bounded while one task remains in flight', async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const ensure = vi.fn(async () => {
      await barrier;
      return { mounted: true };
    });
    const { runner, sent } = makeRunner({
      kinds: [AgentTaskKind.RemoteFsEnsure],
      ensure,
      verify: vi.fn(async () => undefined),
    });

    const original = runner.execute(task);
    const retries = Array.from({ length: 1_000 }, () => runner.execute(task));
    release();
    await Promise.all([original, ...retries]);

    expect(ensure).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
  });

  it('caches terminal success only until matching accepted', async () => {
    const ensure = vi.fn(async () => ({ mounted: true }));
    const { runner, sent } = makeRunner({
      kinds: [AgentTaskKind.RemoteFsEnsure],
      ensure,
      verify: vi.fn(async () => undefined),
    });

    await runner.execute(task);
    await runner.execute(task);
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(2);

    runner.accepted({ taskId: task.taskId, payloadHash: task.payloadHash });
    await runner.execute(task);
    expect(ensure).toHaveBeenCalledTimes(2);
  });

  it('clears terminal cache on connection reset', async () => {
    const ensure = vi.fn(async () => ({ mounted: true }));
    const { runner } = makeRunner({
      kinds: [AgentTaskKind.RemoteFsEnsure],
      ensure,
      verify: vi.fn(async () => undefined),
    });

    await runner.execute(task);
    runner.resetConnection();
    await runner.execute(task);

    expect(ensure).toHaveBeenCalledTimes(2);
  });

  it('caches an old in-flight result only when the new connection re-delivers it', async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const ensure = vi.fn(async () => {
      await barrier;
      return { mounted: true };
    });
    const { runner } = makeRunner({
      kinds: [AgentTaskKind.RemoteFsEnsure],
      ensure,
      verify: vi.fn(async () => undefined),
    });

    const oldDelivery = runner.execute(task);
    runner.resetConnection();
    const newDelivery = runner.execute(task);
    release();
    await Promise.all([oldDelivery, newDelivery]);
    await runner.execute(task);

    expect(ensure).toHaveBeenCalledTimes(1);
  });

  it('never caches incomplete results', async () => {
    const ensure = vi.fn()
      .mockRejectedValueOnce(new Error('mount state could not be observed'))
      .mockRejectedValueOnce(new IncompleteTaskError({
        code: 'probe_unavailable',
        message: '/proc/mounts unavailable',
      }));
    const { runner, sent } = makeRunner({
      kinds: [AgentTaskKind.RemoteFsEnsure],
      ensure,
      verify: vi.fn(async () => undefined),
    });

    await runner.execute(task);
    await runner.execute(task);

    expect(ensure).toHaveBeenCalledTimes(2);
    expect(sent).toEqual([
      expect.objectContaining({
        status: 'incomplete',
        error: expect.objectContaining({ code: 'agent_task_incomplete' }),
      }),
      expect.objectContaining({
        status: 'incomplete',
        error: expect.objectContaining({ code: 'probe_unavailable' }),
      }),
    ]);
  });

  it('turns an oversized terminal outcome into bounded retryable evidence', async () => {
    const ensure = vi.fn(async () => ({
      mounted: true,
      diagnostic: 'x'.repeat(MAX_AGENT_TASK_RESULT_BYTES),
    }));
    const { runner, sent } = makeRunner({
      kinds: [AgentTaskKind.RemoteFsEnsure],
      ensure,
      verify: vi.fn(async () => undefined),
    });

    await runner.execute(task);
    await runner.execute(task);

    expect(ensure).toHaveBeenCalledTimes(2);
    expect(sent).toHaveLength(2);
    expect(sent).toEqual([
      expect.objectContaining({
        status: 'incomplete',
        error: expect.objectContaining({ code: 'agent_task_result_too_large' }),
      }),
      expect.objectContaining({
        status: 'incomplete',
        error: expect.objectContaining({ code: 'agent_task_result_too_large' }),
      }),
    ]);
    expect(sent.every((result) =>
      Buffer.byteLength(canonicalJson(result)) <= MAX_AGENT_TASK_RESULT_BYTES)).toBe(true);
  });

  it('turns a non-JSON handler outcome into retryable evidence instead of dropping the result', async () => {
    const cyclic: Record<string, unknown> = { mounted: true };
    cyclic.self = cyclic;
    const ensure = vi.fn(async () => cyclic);
    const { runner, sent } = makeRunner({
      kinds: [AgentTaskKind.RemoteFsEnsure],
      ensure,
      verify: vi.fn(async () => undefined),
    });

    await runner.execute(task);
    await runner.execute(task);

    expect(ensure).toHaveBeenCalledTimes(2);
    expect(sent).toEqual([
      expect.objectContaining({
        status: 'incomplete',
        error: expect.objectContaining({ code: 'agent_task_result_invalid' }),
      }),
      expect.objectContaining({
        status: 'incomplete',
        error: expect.objectContaining({ code: 'agent_task_result_invalid' }),
      }),
    ]);
  });

  it('emits and caches managed failure only with observed physical state', async () => {
    const ensure = vi.fn(async () => {
      throw new ManagedTaskError(
        { code: 'mount_rejected', message: 'server denied mount' },
        { mounted: false, source: null },
      );
    });
    const { runner, sent } = makeRunner({
      kinds: [AgentTaskKind.RemoteFsEnsure],
      ensure,
      verify: vi.fn(async () => undefined),
    });

    await runner.execute(task);
    await runner.execute(task);

    expect(ensure).toHaveBeenCalledTimes(1);
    expect(sent[0]).toEqual({
      taskId: task.taskId,
      payloadHash: task.payloadHash,
      status: 'failed',
      error: { code: 'mount_rejected', message: 'server denied mount' },
      observed: { mounted: false, source: null },
    });
  });

  it('turns invalid kind payload into an observed terminal failure', async () => {
    const ensure = vi.fn(async () => null);
    const { runner, sent } = makeRunner({
      kinds: [AgentTaskKind.RemoteFsEnsure],
      ensure,
      verify: vi.fn(async () => undefined),
    });

    await runner.execute({ ...task, payload: { id: 'missing-required-fields' } });

    expect(ensure).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({
      status: 'failed',
      error: { code: 'invalid_task_payload' },
      observed: { applied: false, reason: 'invalid_payload' },
    });
  });

  it('refuses a valid but tampered wire payload before physical execution', async () => {
    const ensure = vi.fn(async () => null);
    const { runner, sent } = makeRunner({
      kinds: [AgentTaskKind.RemoteFsEnsure],
      ensure,
      verify: vi.fn(async () => undefined),
    });

    await runner.execute({
      ...task,
      payload: { ...(task.payload as object), options: 'rw,nosuid' },
    });

    expect(ensure).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({
      status: 'failed',
      error: { code: 'task_payload_hash_mismatch' },
      observed: { applied: false, reason: 'invalid_payload' },
    });
  });

  it('terminally rejects a missing handler before any physical execution', async () => {
    const sent: TaskResultPayload[] = [];
    const runner = new AgentTaskRunner(
      new AgentTaskHandlerRegistry([]),
      (result) => sent.push(result),
    );

    await runner.execute(task);

    expect(sent[0]).toMatchObject({
      status: 'failed',
      error: { code: 'unsupported_task_kind' },
      observed: { applied: false, reason: 'invalid_payload' },
    });
  });

  it('rejects task-id reuse with a different payload identity', async () => {
    const { runner } = makeRunner({
      kinds: [AgentTaskKind.RemoteFsEnsure],
      ensure: vi.fn(async () => null),
      verify: vi.fn(async () => undefined),
    });
    await runner.execute(task);

    await expect(runner.execute({ ...task, payloadHash: 'different' }))
      .rejects.toBeInstanceOf(TaskIdentityConflictError);
    expect(() => runner.accepted({ taskId: task.taskId, payloadHash: 'different' }))
      .toThrow(TaskIdentityConflictError);
  });

  it('does not publish success when physical identity changes after verify', async () => {
    const sent: TaskResultPayload[] = [];
    const assertPhysicalEnvironment = vi.fn()
      .mockReturnValueOnce(undefined)
      .mockImplementationOnce(() => { throw new Error('storage identity changed'); });
    const runner = new AgentTaskRunner(
      new AgentTaskHandlerRegistry([{
        kinds: [AgentTaskKind.RemoteFsEnsure],
        ensure: vi.fn(async () => ({ mounted: true })),
        verify: vi.fn(async () => undefined),
      }]),
      (result) => sent.push(result),
      assertPhysicalEnvironment,
    );

    await runner.execute(task);

    expect(assertPhysicalEnvironment).toHaveBeenCalledTimes(2);
    expect(sent).toEqual([
      expect.objectContaining({
        status: 'incomplete',
        error: expect.objectContaining({ message: 'storage identity changed' }),
      }),
    ]);
  });

  it('rechecks physical identity after a handler failure before publishing its outcome', async () => {
    const sent: TaskResultPayload[] = [];
    const assertPhysicalEnvironment = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Docker daemon identity changed'));
    const runner = new AgentTaskRunner(
      new AgentTaskHandlerRegistry([{
        kinds: [AgentTaskKind.RemoteFsEnsure],
        ensure: vi.fn(async () => { throw new ManagedTaskError(
          { code: 'mount_failed', message: 'mount rejected' },
          { applied: false },
        ); }),
        verify: vi.fn(async () => undefined),
      }]),
      (result) => sent.push(result),
      assertPhysicalEnvironment,
    );

    await runner.execute(task);

    expect(assertPhysicalEnvironment).toHaveBeenCalledTimes(2);
    expect(sent).toEqual([
      expect.objectContaining({
        status: 'incomplete',
        error: expect.objectContaining({ message: 'Docker daemon identity changed' }),
      }),
    ]);
  });
});

function makeRunner(handler: AgentTaskHandler): {
  runner: AgentTaskRunner;
  sent: TaskResultPayload[];
} {
  const sent: TaskResultPayload[] = [];
  return {
    runner: new AgentTaskRunner(
      new AgentTaskHandlerRegistry([handler]),
      (result) => sent.push(result),
    ),
    sent,
  };
}

function wireHash(kind: AgentTaskKind, payload: unknown): string {
  return createHash('sha256').update(canonicalJson({ kind, payload })).digest('hex');
}
