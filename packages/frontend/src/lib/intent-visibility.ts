import { IntentStatus, type IntentDto } from '@nyabase/common';
import { api } from './api.js';

export function retryIntentPath(intentId: string, admin: boolean): string {
  return admin ? `/admin/intents/${intentId}/retry` : `/intents/${intentId}/retry`;
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
  if (intent.failure) {
    return `${intent.failure.code}: ${intent.failure.message}`;
  }
  if (intent.failureCode) return intent.failureCode;
  return null;
}

export function isOutstandingIntent(intent: IntentDto): boolean {
  if (intent.status === IntentStatus.Failed) return true;
  return intent.status !== IntentStatus.Succeeded && Boolean(intent.failure || intent.failureCode);
}

export async function retryIntent(intentId: string, admin: boolean): Promise<IntentDto> {
  return api.post<IntentDto>(retryIntentPath(intentId, admin), {});
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
