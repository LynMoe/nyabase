import { describe, expect, it, vi } from 'vitest';
import { IntentKind, IntentResourceType } from '@nyabase/common';
import {
  assertVolumeIntentTarget,
  createVolumeIntent,
  ensureVolumeIntent,
} from './volume-intents.js';

const volumeId = '11111111-1111-4111-8111-111111111111';
const serverId = '33333333-3333-4333-8333-333333333333';
const otherServerId = '44444444-4444-4444-8444-444444444444';

function executor(rows: {
  volume?: { server_id: string | null; shared_backend_id: string | null };
  placementServerIds?: string[];
}) {
  const selectFrom = vi.fn((table: string) => {
    const filters: Record<string, unknown> = {};
    const chain = {
      select: () => chain,
      where: (column: string, _op: string, value: unknown) => {
        filters[column] = value;
        return chain;
      },
      executeTakeFirst: async () => {
        if (table === 'control.volumes') return rows.volume;
        return rows.placementServerIds?.includes(filters.server_id as string)
          ? { server_id: filters.server_id }
          : undefined;
      },
    };
    return chain;
  });
  return { selectFrom } as never;
}

const local = { server_id: serverId, shared_backend_id: null };
const shared = { server_id: null, shared_backend_id: '55555555-5555-4555-8555-555555555555' };

describe('assertVolumeIntentTarget', () => {
  it('accepts a local volume intent on the volume server', async () => {
    await expect(assertVolumeIntentTarget(
      { kind: IntentKind.VolumeEnsure, resourceId: volumeId, serverId },
      executor({ volume: local }),
    )).resolves.toBeUndefined();
  });

  it('rejects a local volume intent for another server', async () => {
    await expect(assertVolumeIntentTarget(
      { kind: IntentKind.VolumeResize, resourceId: volumeId, serverId: otherServerId },
      executor({ volume: local }),
    )).rejects.toThrow('Local volume intent server does not match the volume');
  });

  it('rejects volume.ensure for a shared volume', async () => {
    await expect(assertVolumeIntentTarget(
      { kind: IntentKind.VolumeEnsure, resourceId: volumeId, serverId },
      executor({ volume: shared, placementServerIds: [serverId] }),
    )).rejects.toThrow('Shared volumes cannot enqueue volume.ensure');
  });

  it('requires a registered placement for a shared volume resize', async () => {
    await expect(assertVolumeIntentTarget(
      { kind: IntentKind.VolumeResize, resourceId: volumeId, serverId },
      executor({ volume: shared, placementServerIds: [serverId] }),
    )).resolves.toBeUndefined();
    await expect(assertVolumeIntentTarget(
      { kind: IntentKind.VolumeResize, resourceId: volumeId, serverId: otherServerId },
      executor({ volume: shared, placementServerIds: [serverId] }),
    )).rejects.toThrow('Shared volume intent server does not match a placement');
  });

  it('requires a server for ensure/resize and forbids one for destroy', async () => {
    await expect(assertVolumeIntentTarget(
      { kind: IntentKind.VolumeResize, resourceId: volumeId, serverId: null },
      executor({ volume: local }),
    )).rejects.toThrow('Volume intents require a server id');
    await expect(assertVolumeIntentTarget(
      { kind: IntentKind.VolumeDestroy, resourceId: volumeId, serverId },
      executor({}),
    )).rejects.toThrow('Volume destroy intents cannot carry a server id');
    await expect(assertVolumeIntentTarget(
      { kind: IntentKind.VolumeDestroy, resourceId: volumeId, serverId: null },
      executor({}),
    )).resolves.toBeUndefined();
  });

  it('lets a vanished volume through so the reconciler settles it as not found', async () => {
    await expect(assertVolumeIntentTarget(
      { kind: IntentKind.VolumeEnsure, resourceId: volumeId, serverId },
      executor({}),
    )).resolves.toBeUndefined();
  });
});

describe('volume intent creation', () => {
  const input = {
    kind: IntentKind.VolumeResize,
    resourceType: IntentResourceType.Volume,
    resourceId: volumeId,
    serverId: otherServerId,
    targetRevision: 2,
  } as const;

  it('does not queue an intent that fails validation', async () => {
    const createPending = vi.fn();
    const ensurePending = vi.fn();
    await expect(createVolumeIntent({ createPending }, input, executor({ volume: local })))
      .rejects.toThrow('does not match the volume');
    await expect(ensureVolumeIntent({ ensurePending }, input, executor({ volume: local })))
      .rejects.toThrow('does not match the volume');
    expect(createPending).not.toHaveBeenCalled();
    expect(ensurePending).not.toHaveBeenCalled();
  });

  it('delegates a valid intent to the repository', async () => {
    const createPending = vi.fn().mockResolvedValue({ id: 'intent' });
    const tx = executor({ volume: local });
    await createVolumeIntent({ createPending }, { ...input, serverId }, tx);
    expect(createPending).toHaveBeenCalledWith({ ...input, serverId }, tx);
  });
});
