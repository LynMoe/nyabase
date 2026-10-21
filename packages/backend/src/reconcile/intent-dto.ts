import {
  zAdminIntentListQuery,
  zIntentListQuery,
  type IntentDto,
} from '@nyabase/common';
import type { IntentListOptions, IntentRecord } from './intent.repository.js';

export function toDto(intent: IntentRecord): IntentDto {
  return {
    id: intent.id,
    kind: intent.kind as IntentDto['kind'],
    resourceType: intent.resourceType as IntentDto['resourceType'],
    resourceId: intent.resourceId,
    serverId: intent.serverId,
    requestedBy: intent.requestedBy,
    requestSummary: intent.request ?? {},
    targetRevision: intent.targetRevision,
    baseline: intent.baseline,
    status: intent.status as IntentDto['status'],
    failureCode: intent.failureCode,
    failure: intent.failure
      ? {
        code: intent.failure.code,
        message: intent.failure.message,
        details: intent.failure.details ?? {},
      }
      : null,
    attemptCount: intent.attemptCount,
    nextAttemptAt: intent.nextAttemptAt,
    createdAt: intent.createdAt,
    settledAt: intent.settledAt,
    blockedByIntentId: intent.blockedByIntentId ?? null,
  };
}

export function listOptions(
  query: Record<string, unknown>,
): Pick<IntentListOptions, 'limit' | 'cursor' | 'status' | 'kind'> {
  const parsed = zIntentListQuery.parse(query);
  return {
    limit: parsed.limit,
    cursor: parsed.cursor,
    status: parsed.status as IntentListOptions['status'],
    kind: parsed.kind as IntentListOptions['kind'],
  };
}

export function adminIntentListOptions(query: Record<string, unknown>): IntentListOptions {
  const parsed = zAdminIntentListQuery.parse(query);
  return {
    limit: parsed.limit,
    cursor: parsed.cursor,
    status: parsed.status as IntentListOptions['status'],
    kind: parsed.kind as IntentListOptions['kind'],
    resourceType: parsed.resourceType,
    serverId: parsed.serverId,
  };
}
