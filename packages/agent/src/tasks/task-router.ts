import {
  type BackendToAgentMessage,
  zTaskAcceptedPayload,
  zTaskExecutePayload,
} from '@nyabase/common';
import type { DirectCommandDispatcher } from '../rpc/direct-command-dispatcher.js';
import type { AgentTaskRunner } from './task-runner.js';

const EXEC_DIRECT_KINDS = new Set([
  'execStream',
  'execInput',
  'execResize',
  'execClose',
]);

/** The only ingress split: durable task protocol or direct interactive RPC. */
export class AgentMessageRouter {
  /**
   * Bootstrap snapshots are process-wide authority, not socket-local work.
   * A timed-out old RPC may keep running after reconnect, so every generation
   * joins this FIFO and the newest admitted snapshot is necessarily applied
   * last. This is in-memory serialization only; the Agent still owns no
   * durable task or recovery state.
   */
  private bootstrapTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly tasks: AgentTaskRunner,
    private readonly direct: DirectCommandDispatcher,
    private readonly assertPhysicalEnvironment: () => void = () => undefined,
  ) {}

  async handle(message: BackendToAgentMessage): Promise<void> {
    if (EXEC_DIRECT_KINDS.has(message.kind)) {
      // Call direct.handle before the first await in this event callback. It
      // synchronously reserves open/close work, so a later task.execute event
      // cannot take a stale waitForIdle snapshot and overtake it.
      // Cleanup must remain available even after host identity drift. Blocking
      // execClose here would strand a privileged shell whose Backend owner was
      // already revoked. Admission checks still guard open/input/resize.
      if (message.kind !== 'execClose') this.assertPhysicalEnvironment();
      await this.direct.handle(message);
      return;
    }
    if (message.kind === 'task.execute.v1') {
      // Closing an interactive exec may deliberately stop the whole exact
      // container as a rollback barrier. Do not let that late fallback
      // overwrite the terminal physical state of a newer lifecycle task.
      await this.direct.waitForIdle();
      await this.tasks.execute(zTaskExecutePayload.parse(message.payload));
      return;
    }
    if (message.kind === 'task.accepted.v1') {
      this.tasks.accepted(zTaskAcceptedPayload.parse(message.payload));
      return;
    }
    if (message.kind === 'agent.bootstrap.v1') {
      const previous = this.bootstrapTail;
      const current = previous
        .catch(() => undefined)
        .then(async () => {
          // Ordered physical work begun on the previous socket may outlive
          // disconnect. Adopt the snapshot only after that work settles.
          await this.direct.waitForIdle();
          await this.tasks.waitForIdle();
          this.assertPhysicalEnvironment();
          await this.direct.handle(message);
        });
      this.bootstrapTail = current;
      await current;
      return;
    }
    // In particular, a `reconcile` command must not trigger the first full
    // report before every older and current bootstrap has settled.
    await this.bootstrapTail.catch(() => undefined);
    this.assertPhysicalEnvironment();
    await this.direct.handle(message);
  }

  /** Join any bootstrap started on an older transport generation. */
  async waitForBootstrapIdle(): Promise<void> {
    await this.bootstrapTail.catch(() => undefined);
  }
}
