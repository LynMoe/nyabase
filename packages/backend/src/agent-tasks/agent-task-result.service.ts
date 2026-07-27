import { ConflictException, Injectable } from '@nestjs/common';
import {
  canonicalJson,
  MAX_AGENT_TASK_RESULT_BYTES,
  type TaskAcceptedPayload,
  type TaskResultPayload,
} from '@nyabase/common';
import { ProxySnapshotNotifierService } from '../proxy-snapshots/proxy-snapshot-notifier.service.js';
import { WorkflowFinalizerWorkerService } from './workflow-finalizer-worker.service.js';
import { WorkflowRepository } from './workflow.repository.js';
import type { WorkflowAgentSessionBinding } from './workflow-dispatch.service.js';

/** Canonical PostgreSQL ingress for authenticated Agent task evidence. */
@Injectable()
export class AgentTaskResultService {
  constructor(
    private readonly workflow: WorkflowRepository,
    private readonly finalizers: WorkflowFinalizerWorkerService,
    private readonly proxySnapshots: ProxySnapshotNotifierService,
  ) {}

  async handle(
    serverId: string,
    result: TaskResultPayload,
    session: WorkflowAgentSessionBinding,
  ): Promise<TaskAcceptedPayload | null> {
    const resultBytes = Buffer.byteLength(canonicalJson(result));
    if (resultBytes > MAX_AGENT_TASK_RESULT_BYTES) {
      const error = new ConflictException({
        code: 'TASK_RESULT_SCHEMA_INVALID',
        message: `Agent task result exceeds ${MAX_AGENT_TASK_RESULT_BYTES} bytes`,
      });
      await this.workflow.quarantineInvalidAgentResult(
        serverId,
        result,
        error.getResponse(),
        session,
      );
      this.proxySnapshots.blockServer(
        serverId,
        'Authenticated Agent returned oversized task evidence',
      );
      throw error;
    }

    let accepted: Awaited<ReturnType<WorkflowRepository['acceptAgentResult']>>;
    try {
      accepted = await this.workflow.acceptAgentResult(serverId, result, session);
    } catch (error) {
      if (this.isValidationFailure(error)) {
        await this.workflow.quarantineInvalidAgentResult(
          serverId,
          result,
          error instanceof ConflictException ? error.getResponse() : error,
          session,
        );
        this.proxySnapshots.blockServer(
          serverId,
          'Authenticated Agent returned invalid task evidence',
        );
      }
      throw error;
    }
    if (accepted.serverQuarantined) {
      this.proxySnapshots.blockServer(
        serverId,
        'Safety-critical Agent task evidence is unsafe',
      );
    }
    if (accepted.finalizerPending) this.finalizers.wake();
    return accepted.accepted
      ? { taskId: accepted.taskId, payloadHash: accepted.payloadHash }
      : null;
  }

  async quarantineMalformedResult(
    serverId: string,
    rawPayload: unknown,
    parseError: unknown,
    session: WorkflowAgentSessionBinding,
  ): Promise<string | null> {
    const record = rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload)
      ? rawPayload as Record<string, unknown>
      : null;
    if (
      typeof record?.taskId === 'string'
      && typeof record.payloadHash === 'string'
    ) {
      const taskId = await this.workflow.quarantineInvalidAgentResult(
        serverId,
        { taskId: record.taskId, payloadHash: record.payloadHash },
        parseError,
        session,
      );
      this.proxySnapshots.blockServer(
        serverId,
        'Authenticated Agent returned malformed task evidence',
      );
      return taskId;
    }
    await this.quarantineProtocolFault(serverId, parseError, session);
    return null;
  }

  async quarantineProtocolFault(
    serverId: string,
    error: unknown,
    session: WorkflowAgentSessionBinding,
  ): Promise<void> {
    await this.workflow.quarantineAgentProtocolFault(serverId, error, session);
    this.proxySnapshots.blockServer(
      serverId,
      'Authenticated Agent violated the protocol',
    );
  }

  private isValidationFailure(error: unknown): boolean {
    if (!(error instanceof ConflictException)) return false;
    const response = error.getResponse();
    const code = typeof response === 'object' && response !== null
      ? (response as { code?: unknown }).code
      : undefined;
    if (
      code === 'AGENT_SESSION_STALE'
      || code === 'TASK_RESULT_SESSION_MISMATCH'
    ) return false;
    return typeof code === 'string' && (
      code.startsWith('TASK_')
      || code.startsWith('AGENT_')
    );
  }
}
