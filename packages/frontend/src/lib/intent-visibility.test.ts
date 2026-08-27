import { describe, expect, it } from 'vitest';
import { IntentKind, IntentResourceType, IntentStatus, type IntentDto } from '@nyabase/common';
import {
  formatIntentAttempt,
  formatIntentFailureMessage,
  isOutstandingIntent,
  isRetryableIntent,
  retryIntentPath,
} from './intent-visibility.js';

function intent(overrides: Partial<IntentDto> = {}): IntentDto {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    kind: IntentKind.VolumeResize,
    resourceType: IntentResourceType.Volume,
    resourceId: '22222222-2222-4222-8222-222222222222',
    serverId: null,
    requestedBy: null,
    requestSummary: {},
    targetGeneration: 2,
    baseline: null,
    status: IntentStatus.Failed,
    failureCode: 'VOLUME_SHRINK_BELOW_USAGE',
    failure: {
      code: 'VOLUME_SHRINK_BELOW_USAGE',
      message: 'Volume cannot shrink below observed usage',
      details: {},
    },
    attemptCount: 3,
    nextAttemptAt: '2026-08-13T12:00:00.000Z',
    createdAt: '2026-08-13T00:00:00.000Z',
    settledAt: null,
    ...overrides,
  };
}

describe('intent visibility helpers', () => {
  it('routes retry to admin or user APIs and formats failure plus attempts', () => {
    const failed = intent();
    expect(retryIntentPath(failed.id, true)).toBe(`/admin/intents/${failed.id}/retry`);
    expect(retryIntentPath(failed.id, false)).toBe(`/intents/${failed.id}/retry`);
    expect(isRetryableIntent(failed)).toBe(true);
    expect(isOutstandingIntent(failed)).toBe(true);
    expect(formatIntentFailureMessage(failed)).toBe(
      'VOLUME_SHRINK_BELOW_USAGE: Volume cannot shrink below observed usage',
    );
    expect(formatIntentAttempt(failed)).toMatch(/已尝试 3 次/);
    expect(isRetryableIntent(intent({ status: IntentStatus.Pending }))).toBe(false);
  });
});
