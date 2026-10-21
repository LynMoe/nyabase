import { describe, expect, it, vi } from 'vitest';
import { IntentKind } from '@nyabase/common';
import {
  assertContainerIntentBaseline,
  createContainerIntent,
  isRestartIntent,
  settleContainerIntent,
} from './container-rules.js';

const containerId = '22222222-2222-4222-8222-222222222222';
const serverId = '33333333-3333-4333-8333-333333333333';

describe('isRestartIntent', () => {
  it('is only container.power with action restart', () => {
    expect(isRestartIntent(IntentKind.ContainerPower, { action: 'restart' })).toBe(true);
    expect(isRestartIntent(IntentKind.ContainerPower, { action: 'start' })).toBe(false);
    expect(isRestartIntent(IntentKind.ContainerUpdate, { action: 'restart' })).toBe(false);
    expect(isRestartIntent(IntentKind.ContainerPower, null)).toBe(false);
  });
});

describe('container intent baseline', () => {
  const restart = { kind: IntentKind.ContainerPower, request: { action: 'restart' } } as const;

  it('requires a startedAt-only baseline on restart', () => {
    expect(() => assertContainerIntentBaseline({ ...restart, baseline: undefined }))
      .toThrow('Restart intents require a startedAt baseline');
    expect(() => assertContainerIntentBaseline({ ...restart, baseline: {} }))
      .toThrow('Restart intents require a startedAt baseline');
    expect(() => assertContainerIntentBaseline({
      ...restart,
      baseline: { startedAt: 'x', extra: 1 },
    })).toThrow('Restart intents require a startedAt baseline');
    expect(() => assertContainerIntentBaseline({ ...restart, baseline: { startedAt: 7 } }))
      .toThrow('Restart intents require a startedAt baseline');
    expect(() => assertContainerIntentBaseline({ ...restart, baseline: { startedAt: null } }))
      .not.toThrow();
    expect(() => assertContainerIntentBaseline({
      ...restart,
      baseline: { startedAt: '2026-01-01T00:00:00.000Z' },
    })).not.toThrow();
  });

  it('rejects a baseline on any other container intent', () => {
    expect(() => assertContainerIntentBaseline({
      kind: IntentKind.ContainerPower,
      request: { action: 'start' },
      baseline: { startedAt: null },
    })).toThrow('Only restart intents may carry a baseline');
    expect(() => assertContainerIntentBaseline({
      kind: IntentKind.ContainerUpdate,
      request: {},
      baseline: { startedAt: null },
    })).toThrow('Only restart intents may carry a baseline');
    expect(() => assertContainerIntentBaseline({
      kind: IntentKind.ContainerUpdate,
      request: {},
    })).not.toThrow();
  });

  it('validates before it touches the repository', async () => {
    const createPending = vi.fn().mockResolvedValue({ id: 'intent' });
    await expect(createContainerIntent({ createPending } as never, {
      kind: IntentKind.ContainerPower,
      resourceType: 'container',
      resourceId: containerId,
      serverId,
      targetRevision: 1,
      request: { action: 'restart' },
    })).rejects.toThrow('Restart intents require a startedAt baseline');
    expect(createPending).not.toHaveBeenCalled();
  });
});

describe('settleContainerIntent', () => {
  const intentOf = (kind: string, request: Record<string, unknown>) => ({
    id: '44444444-4444-4444-8444-444444444444',
    kind,
    resourceType: 'container',
    resourceId: containerId,
    serverId,
    request,
  }) as never;
  const settlement = { outcome: 'succeeded', placementServerId: serverId } as const;

  it('sweeps by revision for an ordinary intent, leaving pending restarts alone', async () => {
    const intents = {
      settleOne: vi.fn(),
      settleForObservedRevision: vi.fn().mockResolvedValue({}),
    };
    await settleContainerIntent(
      intents as never,
      intentOf(IntentKind.ContainerUpdate, {}),
      4,
      settlement,
    );
    expect(intents.settleOne).not.toHaveBeenCalled();
    const [type, id, revision, passed, executor, options] =
      intents.settleForObservedRevision.mock.calls[0]!;
    expect([type, id, revision, passed, executor]).toEqual(
      ['container', containerId, 4, settlement, undefined],
    );
    expect(options.keep({ kind: IntentKind.ContainerPower, request: { action: 'restart' } })).toBe(true);
    expect(options.keep({ kind: IntentKind.ContainerUpdate, request: {} })).toBe(false);
  });

  it('settles a successful restart by id and then sweeps what it covered', async () => {
    const intents = {
      settleOne: vi.fn(),
      settleForObservedRevision: vi.fn().mockResolvedValue({}),
    };
    await settleContainerIntent(
      intents as never,
      intentOf(IntentKind.ContainerPower, { action: 'restart' }),
      4,
      settlement,
    );
    expect(intents.settleOne).toHaveBeenCalledWith(
      '44444444-4444-4444-8444-444444444444',
      settlement,
    );
    expect(intents.settleForObservedRevision).toHaveBeenCalledOnce();
  });

  it('settles a failed restart by id only', async () => {
    const intents = { settleOne: vi.fn(), settleForObservedRevision: vi.fn() };
    const failed = {
      outcome: 'failed',
      failure: { code: 'X', message: 'x', details: {} },
      placementServerId: serverId,
    } as const;
    await settleContainerIntent(
      intents as never,
      intentOf(IntentKind.ContainerPower, { action: 'restart' }),
      4,
      failed,
    );
    expect(intents.settleOne).toHaveBeenCalledOnce();
    expect(intents.settleForObservedRevision).not.toHaveBeenCalled();
  });
});
