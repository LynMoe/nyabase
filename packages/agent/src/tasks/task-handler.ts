import type { AgentTaskKind, TaskError } from '@nyabase/common';

/**
 * A managed failure is terminal only because the handler has observed enough
 * real state to prove both the failure and the residual physical state.
 */
export class ManagedTaskError extends Error {
  constructor(
    readonly taskError: TaskError,
    readonly observed: Record<string, unknown>,
  ) {
    super(taskError.message);
    this.name = 'ManagedTaskError';
    if (!observed || typeof observed !== 'object' || Array.isArray(observed)) {
      throw new TypeError('ManagedTaskError requires an observed object');
    }
  }
}

/** A non-terminal execution result. Backend keeps the task pending and retries. */
export class IncompleteTaskError extends Error {
  constructor(readonly taskError: TaskError) {
    super(taskError.message);
    this.name = 'IncompleteTaskError';
  }
}

/**
 * A handler reconciles one high-level target. `ensure` may be entered again
 * after process death or an incomplete result and must probe before every
 * physical effect. Durable recovery state belongs to Backend or the managed
 * resource, never to the Agent process.
 */
export interface AgentTaskHandler<Result = unknown> {
  readonly kinds: readonly AgentTaskKind[];
  ensure(kind: AgentTaskKind, payload: unknown): Promise<Result>;
  verify(kind: AgentTaskKind, payload: unknown, result: Result): Promise<void>;
}

export class MissingAgentTaskHandlerError extends Error {
  constructor(readonly kind: AgentTaskKind) {
    super(`No Agent task handler registered for ${kind}`);
    this.name = 'MissingAgentTaskHandlerError';
  }
}

export class AgentTaskHandlerRegistry {
  private readonly handlers = new Map<AgentTaskKind, AgentTaskHandler>();

  constructor(handlers: readonly AgentTaskHandler[]) {
    for (const handler of handlers) {
      for (const kind of handler.kinds) {
        if (this.handlers.has(kind)) {
          throw new Error(`Duplicate Agent task handler for ${kind}`);
        }
        this.handlers.set(kind, handler);
      }
    }
  }

  get(kind: AgentTaskKind): AgentTaskHandler {
    const handler = this.handlers.get(kind);
    if (!handler) throw new MissingAgentTaskHandlerError(kind);
    return handler;
  }
}
