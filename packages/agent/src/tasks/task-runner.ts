import type {
  AgentTaskKind,
  TaskAcceptedPayload,
  TaskError,
  TaskExecutePayload,
  TaskResultPayload,
} from '@nyabase/common';
import { parseAgentTaskPayload } from '@nyabase/common';
import { canonicalJson } from '@nyabase/common';
import { MAX_AGENT_TASK_RESULT_BYTES } from '@nyabase/common';
import { zTaskResultPayload } from '@nyabase/common';
import { createHash } from 'crypto';
import { ZodError } from 'zod';
import {
  AgentTaskHandlerRegistry,
  IncompleteTaskError,
  ManagedTaskError,
  MissingAgentTaskHandlerError,
} from './task-handler.js';

export type TaskResultSender = (result: TaskResultPayload) => void;
export type AgentObservationKind = 'stateReport';
export type BeforePhysicalTask = (
  task: TaskExecutePayload,
  parsedPayload: unknown,
) => Promise<void | (() => void)>;

type TerminalTaskResult = Extract<TaskResultPayload, { status: 'succeeded' | 'failed' }>;
type SucceededTaskResult = Extract<TaskResultPayload, { status: 'succeeded' }>;
export const MAX_TRACKED_TASKS = 16;
const TERMINAL_OUTCOME_TTL_MS = 10 * 60_000;
const OBSERVATION_KINDS: ReadonlySet<AgentObservationKind> = new Set([
  'stateReport',
]);

interface TaskIdentity {
  kind: AgentTaskKind;
  payloadHash: string;
}

interface ObservationSlot {
  /** At most the latest follow-up is retained for each finite report kind. */
  pending: (() => Promise<void>) | null;
  promise: Promise<void>;
}

export class TaskIdentityConflictError extends Error {
  constructor(taskId: string) {
    super(`Task identity conflict for ${taskId}`);
    this.name = 'TaskIdentityConflictError';
  }
}

/**
 * Connection-local task execution coordinator.
 *
 * It deliberately owns no durable recovery state: Backend re-delivers every
 * pending task after reconnect, and handlers reconcile from physical state.
 */
export class AgentTaskRunner {
  private executionTail: Promise<void> = Promise.resolve();
  private connectionGeneration = 0;
  private readonly observations = new Map<AgentObservationKind, ObservationSlot>();
  private readonly inFlight = new Map<string, {
    identity: TaskIdentity;
    promise: Promise<TaskResultPayload>;
    /** Latest connection generation that observed this physical execution. */
    deliveryGeneration: number;
  }>();
  private readonly terminalOutcomes = new Map<string, {
    identity: TaskIdentity;
    result: TerminalTaskResult;
    cachedAt: number;
  }>();

  constructor(
    private readonly handlers: AgentTaskHandlerRegistry,
    private readonly sendResult: TaskResultSender,
    private readonly assertPhysicalEnvironment: () => void = () => undefined,
    private readonly beforePhysicalTask?: BeforePhysicalTask,
  ) {}

  async execute(task: TaskExecutePayload): Promise<void> {
    this.pruneTerminalOutcomes();
    const identity = this.identity(task);
    const cached = this.terminalOutcomes.get(task.taskId);
    if (cached) {
      this.assertIdentity(task.taskId, cached.identity, identity);
      this.terminalOutcomes.delete(task.taskId);
      this.terminalOutcomes.set(task.taskId, { ...cached, cachedAt: Date.now() });
      this.sendResult(cached.result);
      return;
    }

    const active = this.inFlight.get(task.taskId);
    if (active) {
      this.assertIdentity(task.taskId, active.identity, identity);
      // Backend retries are delivery evidence, not additional result waiters.
      // Remember that the current connection owns the eventual outcome, while
      // the one original invocation remains the only sender. This keeps
      // duplicate dispatch memory and result fan-out strictly O(1).
      active.deliveryGeneration = this.connectionGeneration;
      return;
    }

    if (this.inFlight.size >= MAX_TRACKED_TASKS) {
      this.sendResult({
        taskId: task.taskId,
        payloadHash: task.payloadHash,
        status: 'incomplete',
        error: {
          code: 'agent_task_capacity_reached',
          message: 'Agent task delivery capacity is temporarily full',
        },
      });
      return;
    }

    const generation = this.connectionGeneration;
    const promise = this.enqueue(() => this.run(task));
    this.inFlight.set(task.taskId, { identity, promise, deliveryGeneration: generation });
    try {
      const result = this.boundResult(await promise);
      const deliveryGeneration = this.inFlight.get(task.taskId)?.deliveryGeneration ?? generation;
      if (result.status !== 'incomplete' && deliveryGeneration === this.connectionGeneration) {
        this.terminalOutcomes.set(task.taskId, { identity, result, cachedAt: Date.now() });
        this.pruneTerminalOutcomes();
      }
      this.sendResult(result);
    } finally {
      const current = this.inFlight.get(task.taskId);
      if (current?.promise === promise) this.inFlight.delete(task.taskId);
    }
  }

  /**
   * Serialize a complete physical observation with durable mutations.
   *
   * The key space is deliberately finite and each key retains only one active
   * observation plus the latest follow-up. This prevents report timers/events
   * from creating an unbounded Promise chain while preserving a fresh final
   * observation after a long task or collector.
   */
  enqueueObservation(
    kind: AgentObservationKind,
    work: () => Promise<void>,
  ): Promise<void> {
    if (!OBSERVATION_KINDS.has(kind)) {
      throw new Error(`Unsupported Agent observation kind: ${String(kind)}`);
    }

    const active = this.observations.get(kind);
    if (active) {
      active.pending = work;
      return active.promise;
    }

    // Append synchronously so a task delivered immediately after a report
    // trigger cannot overtake a collector that has not reached its first await.
    const firstExecution = this.enqueue(work);
    const slot: ObservationSlot = {
      pending: null,
      promise: Promise.resolve(),
    };
    this.observations.set(kind, slot);

    const drain = async () => {
      let execution = firstExecution;
      let firstFailure: unknown;
      let failed = false;
      while (true) {
        try {
          await execution;
        } catch (error) {
          if (!failed) firstFailure = error;
          failed = true;
        }

        const next = slot.pending;
        slot.pending = null;
        if (!next) break;
        execution = this.enqueue(next);
      }
      if (failed) throw firstFailure;
    };

    const tracked = drain().finally(() => {
      if (this.observations.get(kind) === slot) this.observations.delete(kind);
      slot.pending = null;
    });
    slot.promise = tracked;
    return tracked;
  }

  accepted(accepted: TaskAcceptedPayload): void {
    const cached = this.terminalOutcomes.get(accepted.taskId);
    if (!cached) return;
    if (cached.identity.payloadHash !== accepted.payloadHash) {
      throw new TaskIdentityConflictError(accepted.taskId);
    }
    this.terminalOutcomes.delete(accepted.taskId);
  }

  /** Forget connection-local terminal acknowledgements after any disconnect. */
  resetConnection(): void {
    this.connectionGeneration += 1;
    this.terminalOutcomes.clear();
  }

  /** Wait until queued mutations and coalesced observations have settled. */
  async waitForIdle(): Promise<void> {
    const observations = Array.from(
      this.observations.values(),
      ({ promise }) => promise.catch(() => undefined),
    );
    await Promise.all([this.executionTail, ...observations]);
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const execution = this.executionTail.then(work, work);
    this.executionTail = execution.then(() => undefined, () => undefined);
    return execution;
  }

  private boundResult(result: TaskResultPayload): TaskResultPayload {
    if (!zTaskResultPayload.safeParse(result).success) {
      return this.invalidResult(result, 'agent_task_result_invalid',
        'Agent task result does not match the protocol schema');
    }
    try {
      if (Buffer.byteLength(canonicalJson(result)) <= MAX_AGENT_TASK_RESULT_BYTES) return result;
    } catch {
      // Handler return values are runtime data despite their TypeScript type.
      // A cyclic or otherwise non-JSON value must not strand the Backend
      // waiting for a result that this connection can never encode.
      return this.invalidResult(result, 'agent_task_result_invalid',
        'Agent task result is not canonical JSON');
    }
    // Never truncate physical evidence into a false terminal proof. Backend
    // will retry this immutable intent and eventually retain it fail-closed if
    // the deterministic Agent defect persists.
    return this.invalidResult(
      result,
      'agent_task_result_too_large',
      `Agent task result exceeds ${MAX_AGENT_TASK_RESULT_BYTES} bytes`,
    );
  }

  private invalidResult(
    result: TaskResultPayload,
    code: string,
    message: string,
  ): TaskResultPayload {
    return {
      taskId: result.taskId,
      payloadHash: result.payloadHash,
      status: 'incomplete',
      error: { code, message },
    };
  }

  private async run(task: TaskExecutePayload): Promise<TaskResultPayload> {
    let parsingPayload = true;
    let releasePhysicalLease: (() => void) | null = null;
    try {
      const handler = this.handlers.get(task.kind);
      const payload = parseAgentTaskPayload(task.kind, task.payload);
      parsingPayload = false;
      const actualPayloadHash = createHash('sha256')
        .update(canonicalJson({ kind: task.kind, payload }))
        .digest('hex');
      if (actualPayloadHash !== task.payloadHash) {
        return {
          taskId: task.taskId,
          payloadHash: task.payloadHash,
          // Hash verification happens before environment checks or handler
          // execution, so this is a proved no-effect terminal failure. Retrying
          // the same immutable bytes can never repair the mismatch.
          status: 'failed',
          error: {
            code: 'task_payload_hash_mismatch',
            message: 'Task wire payload does not match its durable identity',
          },
          observed: { applied: false, reason: 'invalid_payload' },
        };
      }
      releasePhysicalLease = await this.beforePhysicalTask?.(task, payload) ?? null;
      this.assertPhysicalEnvironment();
      const result = await handler.ensure(task.kind, payload);
      await handler.verify(task.kind, payload, result);
      // Never publish success for work that crossed a hot-remount identity
      // boundary after the pre-mutation check.
      this.assertPhysicalEnvironment();
      return {
        taskId: task.taskId,
        payloadHash: task.payloadHash,
        status: 'succeeded',
        result: (result ?? null) as SucceededTaskResult['result'],
      };
    } catch (error) {
      if (error instanceof MissingAgentTaskHandlerError) {
        return {
          taskId: task.taskId,
          payloadHash: task.payloadHash,
          status: 'failed',
          error: {
            code: 'unsupported_task_kind',
            message: error.message,
          },
          observed: { applied: false, reason: 'invalid_payload' },
        };
      }
      if (error instanceof ManagedTaskError) {
        return {
          taskId: task.taskId,
          payloadHash: task.payloadHash,
          status: 'failed',
          error: this.boundedTaskError(error.taskError),
          observed: error.observed,
        };
      }
      if (error instanceof IncompleteTaskError) {
        return {
          taskId: task.taskId,
          payloadHash: task.payloadHash,
          status: 'incomplete',
          error: this.boundedTaskError(error.taskError),
        };
      }
      if (parsingPayload && error instanceof ZodError) {
        return {
          taskId: task.taskId,
          payloadHash: task.payloadHash,
          status: 'failed',
          error: {
            code: 'invalid_task_payload',
            message: 'Task payload does not match its declared kind',
            details: error.flatten(),
          },
          observed: { applied: false, reason: 'invalid_payload' },
        };
      }
      return {
        taskId: task.taskId,
        payloadHash: task.payloadHash,
        status: 'incomplete',
        error: this.incompleteError(error),
      };
    } finally {
      try {
        releasePhysicalLease?.();
      } catch (error) {
        // Lease release is an in-memory identity-guarded Set deletion. Keep a
        // programming defect visible without replacing an already-bounded task
        // result or accidentally invoking the callback twice.
        console.error('[TaskRunner] Physical task lease release failed:', error);
      }
    }
  }

  private identity(task: TaskExecutePayload): TaskIdentity {
    return { kind: task.kind, payloadHash: task.payloadHash };
  }

  private assertIdentity(taskId: string, current: TaskIdentity, next: TaskIdentity): void {
    if (current.kind !== next.kind || current.payloadHash !== next.payloadHash) {
      throw new TaskIdentityConflictError(taskId);
    }
  }

  private incompleteError(error: unknown): TaskError {
    if (error instanceof Error) {
      return this.boundedTaskError({
        code: 'agent_task_incomplete',
        message: error.message,
        details: { name: error.name },
      });
    }
    return this.boundedTaskError({ code: 'agent_task_incomplete', message: String(error) });
  }

  private boundedTaskError(error: TaskError): TaskError {
    const rawCode = typeof error.code === 'string' ? error.code : '';
    const rawMessage = typeof error.message === 'string' ? error.message : '';
    const code = rawCode.slice(0, 128) || 'agent_task_error';
    const message = rawMessage.slice(0, 2048) || 'Agent task failed without a message';
    return {
      code,
      message,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }

  private pruneTerminalOutcomes(now = Date.now()): void {
    for (const [taskId, entry] of this.terminalOutcomes) {
      if (now - entry.cachedAt > TERMINAL_OUTCOME_TTL_MS) {
        this.terminalOutcomes.delete(taskId);
      }
    }
    while (this.terminalOutcomes.size > MAX_TRACKED_TASKS) {
      const oldest = this.terminalOutcomes.keys().next().value as string | undefined;
      if (!oldest) break;
      this.terminalOutcomes.delete(oldest);
    }
  }
}
