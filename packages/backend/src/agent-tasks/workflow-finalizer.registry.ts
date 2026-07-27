import { Injectable } from '@nestjs/common';
import type { AgentTaskKind, TaskResultPayload } from '@nyabase/common';
import type { Transaction } from 'kysely';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import type {
  WorkflowFinalizerOutcome,
  WorkflowTaskRecord,
} from './workflow.repository.js';

export type WorkflowTerminalResult = Exclude<
  TaskResultPayload,
  { status: 'incomplete' }
>;

export type WorkflowFinalizerHandler = (
  transaction: Transaction<NyabaseDatabase>,
  task: WorkflowTaskRecord,
  result: WorkflowTerminalResult,
) => Promise<WorkflowFinalizerOutcome>;

/**
 * Domain modules register only after their PostgreSQL projection finalizer is
 * ready. The dispatcher uses this registry as a fail-closed admission gate.
 */
@Injectable()
export class WorkflowFinalizerRegistry {
  private readonly handlers = new Map<AgentTaskKind, WorkflowFinalizerHandler>();

  register(
    kind: AgentTaskKind,
    handler: WorkflowFinalizerHandler,
  ): () => void {
    if (this.handlers.has(kind)) {
      throw new Error(`Workflow finalizer already registered for ${kind}`);
    }
    this.handlers.set(kind, handler);
    return () => {
      if (this.handlers.get(kind) === handler) this.handlers.delete(kind);
    };
  }

  get(kind: AgentTaskKind): WorkflowFinalizerHandler | null {
    return this.handlers.get(kind) ?? null;
  }

  supportedKinds(): AgentTaskKind[] {
    return [...this.handlers.keys()].sort();
  }
}
