import type {
  IntentAcceptedDto,
} from '@nyabase/common';
import { IntentStatus, ResourceLifecyclePhase } from '@nyabase/common';
import type { IntentRecord } from '../runtime/intent.repository.js';

export function numberValue(value: string | number | bigint | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const result = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isFinite(result) || result < 0) return 0;
  return result;
}

export function nullableNumber(
  value: string | number | bigint | null | undefined,
): number | null {
  return value === null || value === undefined ? null : numberValue(value);
}

export function poolLabel(displayName: string | null | undefined, incusName: string): string {
  const named = displayName?.trim() ?? '';
  return named.length > 0 ? named : incusName;
}

export function isoDate(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function lifecyclePhase(value: string): ResourceLifecyclePhase {
  if (
    value === 'provisioning'
    || value === 'active'
    || value === 'deleting'
    || value === 'failed'
  ) {
    return value as ResourceLifecyclePhase;
  }
  throw new Error(`Unknown resource lifecycle phase: ${value}`);
}

export function acceptedIntent(intent: IntentRecord): IntentAcceptedDto {
  return {
    intentId: intent.id,
    resourceType: intent.resourceType as IntentAcceptedDto['resourceType'],
    resourceId: intent.resourceId,
    serverId: intent.serverId,
    targetGeneration: intent.targetGeneration,
    status: 'pending' as IntentStatus.Pending,
    createdAt: intent.createdAt,
  };
}

export function deterministicName(prefix: 'nyc' | 'nyv' | 'nyd', id: string): string {
  const normalized = id.replaceAll('-', '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(normalized)) {
    throw new Error('Resource id must be a UUID');
  }
  return `${prefix}-${normalized}`;
}
