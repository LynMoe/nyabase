import {
  IntentStatus,
  type CursorPaginatedResponse,
  type IntentAcceptedDto,
  type IntentDto,
  type IntentResourceType,
  type ListScope,
} from '@nyabase/common';
import { api } from './api.js';
import { waitUntil } from './storage-shrink.js';
import { failureCodeLabel } from './status-labels.js';

export function retryIntentPath(intentId: string): string {
  return `/intents/${intentId}/retry`;
}

/**
 * `GET /intents` for one resource (or several, e.g. every assignment of an
 * image). `scope=all` is for administrators looking at someone else's resource.
 */
export function resourceIntentsPath(
  scope: ListScope,
  resourceType: IntentResourceType,
  resourceId: string | readonly string[],
): string {
  const ids = typeof resourceId === 'string' ? resourceId : resourceId.join(',');
  return `/intents?${scope === 'all' ? 'scope=all&' : ''}resourceType=${resourceType}&resourceId=${ids}`;
}

export function isRetryableIntent(intent: Pick<IntentDto, 'status'>): boolean {
  return intent.status === IntentStatus.Failed;
}

export function formatIntentAttempt(intent: Pick<IntentDto, 'attemptCount' | 'nextAttemptAt'>): string {
  const parts = [`已尝试 ${intent.attemptCount} 次`];
  if (intent.nextAttemptAt) {
    parts.push(`下次 ${new Date(intent.nextAttemptAt).toLocaleString()}`);
  }
  return parts.join(' · ');
}

export function formatIntentFailureMessage(
  intent: Pick<IntentDto, 'failure' | 'failureCode'>,
): string | null {
  const code = intent.failure?.code ?? intent.failureCode ?? null;
  const zh = failureCodeLabel(code);
  const message = intent.failure?.message ?? null;
  if (zh && code && zh !== code) {
    return message ? `${zh}（${code}）` : zh;
  }
  if (code && message) return `${code}: ${message}`;
  return message ?? code;
}

export function isOutstandingIntent(intent: IntentDto): boolean {
  if (intent.status === IntentStatus.Failed) return true;
  return intent.status !== IntentStatus.Succeeded && Boolean(intent.failure || intent.failureCode);
}

export function outstandingIntentKey(intent: Pick<IntentDto, 'kind' | 'resourceId'>): string {
  return `${intent.kind}:${intent.resourceId}`;
}

/** Newest-first. One current failure per kind+resource; a later success hides older failures. */
export function currentOutstandingIntents(items: readonly IntentDto[]): IntentDto[] {
  return latestIntentsByResource(items).filter((intent) => isOutstandingIntent(intent));
}

/** Newest-first. Keep the current row for each kind+resource; drop superseded scans. */
export function latestIntentsByResource(items: readonly IntentDto[]): IntentDto[] {
  const seen = new Set<string>();
  const latest: IntentDto[] = [];
  for (const intent of items) {
    const key = outstandingIntentKey(intent);
    if (seen.has(key)) continue;
    seen.add(key);
    latest.push(intent);
  }
  return latest;
}

export async function retryIntent(intentId: string): Promise<IntentDto> {
  return api.post<IntentDto>(retryIntentPath(intentId), {});
}

export function isIntentAccepted(value: unknown): value is IntentAcceptedDto {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof (value as IntentAcceptedDto).intentId === 'string'
    && (value as IntentAcceptedDto).intentId.length > 0,
  );
}

export async function waitForResourceIntent(
  listPath: string,
  intentId: string,
): Promise<IntentDto> {
  let latest: IntentDto | null = null;
  await waitUntil(async () => {
    const page = await api.get<CursorPaginatedResponse<IntentDto>>(
      `${listPath}${listPath.includes('?') ? '&' : '?'}limit=50`,
    );
    latest = (page.items ?? []).find((intent) => intent.id === intentId) ?? null;
    if (!latest) return false;
    if (latest.status === IntentStatus.Failed) {
      throw new Error(formatIntentFailureMessage(latest) ?? '操作失败');
    }
    return latest.status === IntentStatus.Succeeded;
  }, {
    timeoutMs: 120_000,
    intervalMs: 1_000,
    label: '数据卷操作',
    onTimeout: async () => lookupLatestIntentFailure(listPath),
  });
  if (!latest) throw new Error('操作没有返回结果');
  return latest;
}

export async function lookupLatestIntentFailure(listPath: string): Promise<string | null> {
  const separator = listPath.includes('?') ? '&' : '?';
  try {
    const page = await api.get<{ items: IntentDto[] }>(`${listPath}${separator}limit=20`);
    const failed = (page.items ?? []).find((intent) => isOutstandingIntent(intent));
    return failed ? formatIntentFailureMessage(failed) : null;
  } catch {
    return null;
  }
}

/** Badge colour of an intent status. */
export function statusBadgeVariant(status: string) {
  if (status === IntentStatus.Succeeded) return 'success' as const;
  if (status === IntentStatus.Failed) return 'destructive' as const;
  return 'warning' as const;
}
