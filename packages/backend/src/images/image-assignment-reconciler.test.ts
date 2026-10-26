import { describe, expect, it, vi } from 'vitest';
import { IncusError } from '../incus/incus-errors.js';
import { canDeleteManagedImage, selectImageForAssignment } from './image-assignment-ops.js';
import { ImageReconcileStore } from './image-reconcile.store.js';
import { ImageAssignmentReconciler } from './image-assignment-reconciler.service.js';
import { DEFAULT_IMAGE_SOURCE_SERVER } from '@nyabase/common';

/** `recordEnsured` also records the fingerprint as an image version. */
function insertQuery() {
  const query = {
    values: vi.fn(() => query),
    columns: vi.fn(() => query),
    expression: vi.fn(() => query),
    onConflict: vi.fn(() => query),
    execute: vi.fn().mockResolvedValue([]),
  };
  return query;
}

describe('image assignment reconciliation policy', () => {
  const image = {
    fingerprint: 'a'.repeat(64),
    aliases: [{ name: 'ubuntu' }],
  };

  it('reuses an image already present on the server', () => {
    expect(selectImageForAssignment([image], {
      alias: 'ubuntu',
      fingerprint: null,
    })).toBe(image);
    expect(selectImageForAssignment([image], {
      alias: 'ubuntu',
      fingerprint: 'a'.repeat(64),
    })).toBe(image);
  });

  it('never falls back to an alias when a fingerprint is pinned', () => {
    const aliasMatch = {
      fingerprint: 'b'.repeat(64),
      aliases: [{ name: 'ubuntu' }],
    };

    expect(selectImageForAssignment([aliasMatch], {
      alias: 'ubuntu',
      fingerprint: 'a'.repeat(64),
    })).toBeUndefined();
    expect(selectImageForAssignment([
      aliasMatch,
      image,
    ], {
      alias: 'ubuntu',
      fingerprint: 'a'.repeat(64),
    })).toBe(image);
  });

  it('does not delete a mismatched or referenced image', () => {
    const base = {
      managedFingerprint: 'a'.repeat(64),
      actualFingerprint: 'a'.repeat(64),
      otherAssignment: false,
      pinned: false,
      usedBy: false,
    };
    expect(canDeleteManagedImage(base)).toBe(true);
    expect(canDeleteManagedImage({ ...base, actualFingerprint: 'b'.repeat(64) })).toBe(false);
    expect(canDeleteManagedImage({ ...base, otherAssignment: true })).toBe(false);
    expect(canDeleteManagedImage({ ...base, pinned: true })).toBe(false);
    expect(canDeleteManagedImage({ ...base, usedBy: true })).toBe(false);
  });

  it('is idempotent when the pinned image is already managed', async () => {
    const selectTakeFirst = vi.fn().mockResolvedValue({
      id: 'assignment-1',
      image_id: 'image-1',
      server_id: 'server-1',
      revision: 4,
      observed_fingerprint: image.fingerprint,
      managed_fingerprint: image.fingerprint,
      lifecycle_phase: 'active',
      alias: 'ubuntu',
      desired_fingerprint: image.fingerprint,
      cleanup_generation: 0,
    });
    const selectQuery = {
      innerJoin: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      groupBy: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      execute: vi.fn().mockResolvedValue([]),
      executeTakeFirst: selectTakeFirst,
    };
    const updateQuery = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockReturnThis(),
      execute: vi.fn().mockResolvedValue([]),
      executeTakeFirst: vi.fn().mockResolvedValue(undefined),
    };
    const database = {
      selectFrom: vi.fn(() => selectQuery),
      updateTable: vi.fn(() => updateQuery),
      insertInto: vi.fn(() => insertQuery()),
    };
    const createImage = vi.fn();
    const client = {
      listImages: vi.fn().mockResolvedValue({ metadata: [image] }),
      createImage,
    };
    const reconciler = new ImageAssignmentReconciler(
      new ImageReconcileStore(database as never),
      { get: (key: string) => (key === 'incus.preflightSourceServer' ? DEFAULT_IMAGE_SOURCE_SERVER : '') } as never,
      {} as never,
      { log: vi.fn().mockResolvedValue(undefined) } as never,
      { register: vi.fn() } as never,
    );
    const context = {
      intent: {
        resourceType: 'image_assignment',
        resourceId: 'assignment-1',
        serverId: 'server-1',
      },
      client,
      claim: {},
      lease: {},
      signal: new AbortController().signal,
    };

    await expect(reconciler.reconcile(context as never)).resolves.toEqual({
      outcome: 'succeeded',
      observedRevision: 4,
    });
    await expect(reconciler.reconcile(context as never)).resolves.toEqual({
      outcome: 'succeeded',
      observedRevision: 4,
    });

    expect(createImage).not.toHaveBeenCalled();
    expect(client.listImages).toHaveBeenCalledTimes(4);
  });

  it('cuts over A to B, keeps A as an earlier version, and leaves B on a second ensure', async () => {
    const fingerprintA = 'a'.repeat(64);
    const fingerprintB = 'b'.repeat(64);
    const imageA = { fingerprint: fingerprintA, aliases: [{ name: 'ubuntu/24.04' }], used_by: [] };
    const imageB = { fingerprint: fingerprintB, aliases: [], used_by: [] };
    const assignment = {
      id: 'assignment-1',
      image_id: 'image-1',
      server_id: 'server-1',
      revision: 2,
      observed_fingerprint: fingerprintA,
      managed_fingerprint: fingerprintA,
      lifecycle_phase: 'active',
      alias: 'ubuntu/24.04',
      desired_fingerprint: fingerprintB,
      cleanup_generation: 0,
    };
    const selectQuery = {
      innerJoin: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      groupBy: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      execute: vi.fn().mockResolvedValue([]),
      executeTakeFirst: vi.fn().mockResolvedValue(assignment),
    };
    const updateQuery = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockReturnThis(),
      execute: vi.fn().mockResolvedValue([]),
      executeTakeFirst: vi.fn().mockResolvedValue(undefined),
    };
    const database = {
      selectFrom: vi.fn(() => selectQuery),
      updateTable: vi.fn(() => updateQuery),
      insertInto: vi.fn(() => insertQuery()),
    };
    const client = {
      listImages: vi.fn()
        .mockResolvedValueOnce({ metadata: [imageA] })
        .mockResolvedValueOnce({ metadata: [imageA, imageB] })
        .mockResolvedValueOnce({ metadata: [imageB] }),
      createImage: vi.fn().mockResolvedValue({
        status: 202,
        envelope: { type: 'async', operation: '/1.0/operations/op-1' },
        metadata: undefined,
      }),
      getOperationWait: vi.fn().mockResolvedValue({
        status: 200,
        envelope: { type: 'sync' },
        metadata: { status: 'Success', status_code: 200 },
      }),
      deleteImageAlias: vi.fn().mockResolvedValue({ status: 200, metadata: {} }),
      createImageAlias: vi.fn().mockResolvedValue({ status: 200, metadata: {} }),
      getImage: vi.fn(),
      deleteImage: vi.fn().mockResolvedValue({
        status: 202,
        envelope: { type: 'async', operation: '/1.0/operations/op-2' },
        metadata: undefined,
      }),
    };
    let previousGets = 0;
    client.getImage.mockImplementation(async (fingerprint: string) => {
      if (fingerprint === fingerprintA) {
        previousGets += 1;
        if (previousGets === 1) return { metadata: imageA };
        throw new IncusError('INCUS_NOT_FOUND', 'retry', { reason: 'missing' });
      }
      return { metadata: imageB };
    });
    const reconciler = new ImageAssignmentReconciler(
      new ImageReconcileStore(database as never),
      { get: (key: string) => (key === 'incus.preflightSourceServer' ? DEFAULT_IMAGE_SOURCE_SERVER : '') } as never,
      {} as never,
      { log: vi.fn().mockResolvedValue(undefined) } as never,
      { register: vi.fn() } as never,
    );
    const context = {
      intent: {
        resourceType: 'image_assignment',
        resourceId: 'assignment-1',
        serverId: 'server-1',
      },
      client,
      claim: {},
      lease: {},
      signal: new AbortController().signal,
    };
    await expect(reconciler.reconcile(context as never)).resolves.toEqual({
      outcome: 'succeeded',
      observedRevision: 2,
    });
    expect(client.createImage).toHaveBeenCalledWith(
      expect.objectContaining({ aliases: [] }),
      expect.anything(),
    );
    // A stays for the containers created from it until its version is deleted.
    expect(client.deleteImage).not.toHaveBeenCalled();
    expect(client.createImageAlias).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'ubuntu/24.04', target: fingerprintB }),
    );

    assignment.managed_fingerprint = fingerprintB;
    assignment.observed_fingerprint = fingerprintB;
    assignment.desired_fingerprint = fingerprintB;
    client.listImages.mockResolvedValue({ metadata: [{ ...imageB, aliases: [{ name: 'ubuntu/24.04' }] }] });
    client.deleteImage.mockClear();
    await expect(reconciler.reconcile(context as never)).resolves.toEqual({
      outcome: 'succeeded',
      observedRevision: 2,
    });
    expect(client.deleteImage).not.toHaveBeenCalled();
  });

  it('uses the observed image fingerprint as the full-scan idempotency key', async () => {
    const serverId = '00000000-0000-4000-8000-000000000011';
    const imageId = '00000000-0000-4000-8000-000000000012';
    const assignmentId = '00000000-0000-4000-8000-000000000013';
    const assignment = {
      id: assignmentId,
      image_id: imageId,
      server_id: serverId,
      revision: 2,
      observed_fingerprint: image.fingerprint,
      managed_fingerprint: image.fingerprint,
      lifecycle_phase: 'active',
      alias: 'ubuntu',
      desired_fingerprint: image.fingerprint,
      cleanup_generation: 0,
    };
    const query = (table: string) => ({
      innerJoin: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      groupBy: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      execute: vi.fn().mockResolvedValue(
        table === 'infra.image_server_assignments as a'
          ? [assignment]
          : table === 'infra.servers'
            ? [{ id: serverId }]
            : table === 'infra.image_server_assignments'
              ? [{ image_id: imageId }]
              : [],
      ),
      executeTakeFirst: vi.fn().mockResolvedValue(
        table === 'infra.servers' ? { id: serverId } : undefined,
      ),
    });
    const deleteQuery = { where: vi.fn(() => deleteQuery), execute: vi.fn().mockResolvedValue([]) };
    const database = {
      selectFrom: vi.fn((table: string) => query(table)),
      deleteFrom: vi.fn(() => deleteQuery),
    };
    const settled = new Map<string, { id: string }>();
    const intents = {
      ensurePending: vi.fn(async (input: {
        request?: Record<string, unknown>;
      }) => {
        const key = String(input.request?.idempotencyKey ?? 'default');
        const existing = settled.get(key);
        if (existing) return existing;
        const created = { id: `intent-${settled.size + 1}` };
        settled.set(key, created);
        return created;
      }),
    };
    const client = {
      listImages: vi.fn()
        .mockResolvedValueOnce({ metadata: [image] })
        .mockResolvedValueOnce({ metadata: [image] })
        .mockResolvedValueOnce({ metadata: [] }),
    };
    const reconciler = new ImageAssignmentReconciler(
      new ImageReconcileStore(database as never),
      { get: (key: string) => (key === 'incus.preflightSourceServer' ? DEFAULT_IMAGE_SOURCE_SERVER : '') } as never,
      intents as never,
      { log: vi.fn().mockResolvedValue(undefined) } as never,
      { register: vi.fn() } as never,
    );

    await reconciler.scan(serverId, client as never);
    await reconciler.scan(serverId, client as never);
    await reconciler.scan(serverId, client as never);

    expect(intents.ensurePending).toHaveBeenCalledTimes(3);
    expect(settled).toHaveLength(2);
  });
});
