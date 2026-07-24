import {
  MAX_AGENT_TASK_RESULT_BYTES,
  canonicalJson,
  zTaskResultPayload,
  type TaskResultPayload,
} from '@nyabase/common';
import type { AgentTaskEntity } from '../entities/agent-task.entity.js';
import {
  validateDurableAgentTaskIdentity,
  validateDurableAgentTaskRowIdentity,
} from './agent-task-durable-contract.js';
import { validateTerminalAgentResult } from './agent-task-result-validator.js';

export const STAGED_AGENT_RESULT_CORRUPT_CODE = 'STAGED_AGENT_RESULT_CORRUPT';

export class StagedTerminalEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StagedTerminalEvidenceError';
  }
}

/**
 * Rebuilds the wire-level terminal result from the deliberately smaller
 * persisted evidence envelope, then repeats the same task-kind identity proof
 * used at Agent ingress. Durable evidence can outlive a process/schema version
 * and may be repaired manually after quarantine, so first-stage validation is
 * not sufficient for a later lock-releasing projection.
 */
export function parseAndValidateStagedTerminalResult(
  task: AgentTaskEntity,
  wireCandidate: unknown | (() => unknown),
): Exclude<TaskResultPayload, { status: 'incomplete' }> {
  try {
    // Row identity is never part of the no-send compatibility exception. A
    // corrupt payload may explain why dispatch was refused; an unknown kind,
    // wrong resource type, or invalid durable Server/resource ID cannot.
    validateDurableAgentTaskRowIdentity(task);
    const evidence = record(task.agentResultJson);
    if (
      Object.prototype.hasOwnProperty.call(evidence, 'taskId')
      || Object.prototype.hasOwnProperty.call(evidence, 'payloadHash')
    ) {
      throw new Error('persisted Agent evidence must not contain task identity fields');
    }
    const parsed = zTaskResultPayload.parse({
      ...evidence,
      // Inject immutable identity last so persisted JSON can never select a
      // different task even if this guard is weakened during a later refactor.
      taskId: task.id,
      payloadHash: task.payloadHash,
    });
    if (parsed.status === 'incomplete') {
      throw new Error('persisted Agent evidence is not terminal');
    }
    // The durable evidence envelope deliberately omits immutable task
    // identity. Re-apply the wire limit after those fields are injected: an
    // envelope that fit by itself can otherwise reconstruct into a result the
    // Agent ingress contract would never accept.
    if (Buffer.byteLength(canonicalJson(parsed)) > MAX_AGENT_TASK_RESULT_BYTES) {
      throw new Error(
        `reconstructed Agent task result exceeds ${MAX_AGENT_TASK_RESULT_BYTES} bytes`,
      );
    }

    const dispatchNoEffect = parsed.status === 'failed'
      && parsed.observed.applied === false
      && parsed.observed.reason === 'never_dispatched';
    // Exact never-dispatched evidence is the sole compatibility exception to
    // wire-payload reconstruction: the payload itself may be why dispatch was
    // refused, no Agent send/mutation occurred, and no payload-derived physical
    // projection is applied. The durable send markers and task-bound evidence
    // below remain mandatory; any contradiction follows the corrupt-evidence
    // quarantine path with its evidence and locks retained.
    const wirePayload = dispatchNoEffect
      ? null
      : validateDurableAgentTaskIdentity(task, resolveWireCandidate(wireCandidate));
    if (dispatchNoEffect) {
      const historicalExhaustedDispatch = task.failureStage === 'finalizer'
        && errorCode(task.errorJson) === 'FINALIZER_RETRY_EXHAUSTED';
      if (
        task.startedAt !== null
        || task.lastSentAt !== null
        || (task.failureStage !== 'dispatch' && !historicalExhaustedDispatch)
      ) {
        throw new Error('never-dispatched evidence conflicts with durable prior-send markers');
      }
      validateTerminalAgentResult(task, parsed, { source: 'dispatch' });
    } else {
      validateTerminalAgentResult(task, parsed, { wirePayload });
    }
    return parsed;
  } catch (error) {
    if (error instanceof StagedTerminalEvidenceError) throw error;
    throw new StagedTerminalEvidenceError(errorMessage(error).slice(0, 2048));
  }
}

function resolveWireCandidate(candidate: unknown | (() => unknown)): unknown {
  return typeof candidate === 'function' ? candidate() : candidate;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('persisted Agent evidence is not an object');
  }
  return value as Record<string, unknown>;
}

function errorCode(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const code = (value as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function errorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return 'Unprintable staged Agent evidence error';
  }
}
