import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  Capability,
  IntentKind,
  IntentResourceType,
  IntentStatus,
} from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';
import { IntentsController } from './intents.controller.js';
import { testActor } from '../iam/actor.test-helper.js';
import type { IntentRecord, IntentRepository } from './intent.repository.js';
import type { AccessResolverService } from '../iam/access-resolver.service.js';

const USER_ID = '00000000-0000-4000-8000-0000000000aa';
const OTHER_ID = '00000000-0000-4000-8000-0000000000bb';

function intent(overrides: Partial<IntentRecord> = {}): IntentRecord {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    kind: IntentKind.VolumeEnsure,
    resourceType: IntentResourceType.Volume,
    resourceId: '00000000-0000-4000-8000-000000000002',
    serverId: '00000000-0000-4000-8000-000000000003',
    requestedBy: OTHER_ID,
    request: {},
    targetRevision: 1,
    baseline: null,
    status: IntentStatus.Failed,
    failureCode: 'VOLUME_ENSURE_FAILED',
    failure: { code: 'VOLUME_ENSURE_FAILED', message: 'failed' },
    attemptCount: 1,
    nextAttemptAt: null,
    createdAt: '2026-08-13T00:00:00.000Z',
    settledAt: '2026-08-13T00:00:01.000Z',
    blockedByIntentId: null,
    ...overrides,
  };
}


interface Authority { ownerId: string | null; adminCapability: Capability | null }

function controller(options: {
  list?: ReturnType<typeof vi.fn>;
  findById?: ReturnType<typeof vi.fn>;
  retry?: ReturnType<typeof vi.fn>;
  /** Live capabilities as seen by the in-transaction re-check. */
  liveCapabilities?: Set<Capability>;
  authority?: Authority;
}) {
  const intents = {
    list: options.list ?? vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    findById: options.findById ?? vi.fn(),
    retry: options.retry ?? vi.fn(),
  };
  const live = options.liveCapabilities ?? new Set<Capability>();
  const access = {
    runWithActorCapabilities: vi.fn(async (
      _actorId: string,
      required: Iterable<Capability>,
      work: (transaction: unknown) => Promise<unknown>,
    ) => {
      const missing = [...required].filter((capability) => !live.has(capability));
      if (missing.length > 0) {
        throw new ForbiddenException({
          code: 'PRIVILEGE_ESCALATION_DENIED',
          message: 'The actor does not hold the required capabilities',
          missingCapabilities: missing,
        });
      }
      return work({});
    }),
  };
  const authority = options.authority ?? { ownerId: null, adminCapability: Capability.ManageVolumes };
  const registry = {
    forResource: vi.fn(() => ({
      resourceAuthorities: vi.fn(async (ids: readonly string[]) =>
        new Map(ids.map((id) => [id, authority]))),
    })),
  };
  return {
    controller: new IntentsController(
      intents as unknown as IntentRepository,
      access as unknown as AccessResolverService,
      registry as never,
    ),
    intents,
    access,
  };
}

const volumeId = '00000000-0000-4000-8000-000000000002';
const pageOf = (items: IntentRecord[] = []) => ({ items, nextCursor: null });

describe('IntentsController GET /intents', () => {
  it('scope=all lists only intents whose resource type the actor can administer', async () => {
    const { controller: c, intents } = controller({});
    const operator = testActor(USER_ID, Capability.ManageContainersAny, Capability.ManageServers, Capability.ManageImages);

    await c.list(operator, { scope: 'all' });

    expect(intents.list).toHaveBeenCalledWith({
      limit: 500,
      cursor: undefined,
      status: undefined,
      kind: undefined,
      resourceType: undefined,
      serverId: undefined,
      resourceTypes: [
        IntentResourceType.Container,
        IntentResourceType.ImageAssignment,
        IntentResourceType.Server,
      ],
    });
  });

  it('scope=all needs one of the intent capabilities (403 otherwise)', async () => {
    const { controller: c, intents } = controller({});
    await expect(c.list(testActor(USER_ID), { scope: 'all' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(c.list(testActor(USER_ID, Capability.ManageUsers), { scope: 'all' }))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(intents.list).not.toHaveBeenCalled();
  });

  it('forwards filters and an explicit limit', async () => {
    const serverId = '00000000-0000-4000-8000-000000000003';
    const { controller: c, intents } = controller({});
    await c.list(testActor(USER_ID, Capability.ManageContainersAny, Capability.ManageServers), {
      scope: 'all',
      resourceType: IntentResourceType.Container,
      serverId,
      status: IntentStatus.Pending,
      limit: '50',
    });
    expect(intents.list).toHaveBeenCalledWith({
      limit: 50,
      cursor: undefined,
      status: IntentStatus.Pending,
      kind: undefined,
      resourceType: IntentResourceType.Container,
      serverId,
      resourceTypes: undefined,
    });
  });

  it('returns an empty page when the actor cannot administer the requested resourceType', async () => {
    const { controller: c, intents } = controller({});
    const result = await c.list(
      testActor(USER_ID, Capability.ManageContainersAny),
      { scope: 'all', resourceType: IntentResourceType.Volume },
    );
    expect(result).toEqual({ items: [], nextCursor: null });
    expect(intents.list).not.toHaveBeenCalled();
  });

  it('drops volume intents whose own capability the actor lacks', async () => {
    const shared = intent({ id: '00000000-0000-4000-8000-0000000000e1' });
    const { controller: c } = controller({
      list: vi.fn().mockResolvedValue(pageOf([shared])),
      authority: { ownerId: null, adminCapability: Capability.ManageSharedVolumes },
    });
    const result = await c.list(testActor(USER_ID, Capability.ManageVolumes), { scope: 'all' });
    expect(result.items).toEqual([]);
  });

  it('scope=mine lists what the caller requested, with the 100 page cap', async () => {
    const { controller: c, intents } = controller({});
    await c.list(testActor(USER_ID), {});
    expect(intents.list).toHaveBeenCalledWith(expect.objectContaining({
      limit: 50,
      requestedBy: USER_ID,
    }));
    await expect(c.list(testActor(USER_ID), { limit: '500' })).rejects.toThrow();
  });

  it('scope=mine for a resource requires owning it (404 otherwise)', async () => {
    const owned = controller({ authority: { ownerId: USER_ID, adminCapability: Capability.ManageVolumes } });
    await owned.controller.list(testActor(USER_ID), {
      resourceType: IntentResourceType.Volume,
      resourceId: volumeId,
    });
    expect(owned.intents.list).toHaveBeenCalledWith(expect.objectContaining({
      resourceType: IntentResourceType.Volume,
      resourceIds: [volumeId],
    }));

    const foreign = controller({ authority: { ownerId: OTHER_ID, adminCapability: Capability.ManageVolumes } });
    await expect(foreign.controller.list(testActor(USER_ID), {
      resourceType: IntentResourceType.Volume,
      resourceId: volumeId,
    })).rejects.toBeInstanceOf(NotFoundException);
    // holding the capability does not widen scope=mine
    await expect(foreign.controller.list(testActor(USER_ID, Capability.ManageVolumes), {
      resourceType: IntentResourceType.Volume,
      resourceId: volumeId,
    })).rejects.toBeInstanceOf(NotFoundException);
    expect(foreign.intents.list).not.toHaveBeenCalled();
  });

  it('scope=all for a resource needs that resource\'s capability and accepts several ids', async () => {
    const { controller: c, intents } = controller({
      authority: { ownerId: OTHER_ID, adminCapability: Capability.ManageImages },
    });
    await expect(c.list(testActor(USER_ID, Capability.ManageServers), {
      scope: 'all',
      resourceType: IntentResourceType.ImageAssignment,
      resourceId: 'a1,a2',
    })).rejects.toBeInstanceOf(ForbiddenException);
    await c.list(testActor(USER_ID, Capability.ManageImages), {
      scope: 'all',
      resourceType: IntentResourceType.ImageAssignment,
      resourceId: 'a1,a2',
    });
    expect(intents.list).toHaveBeenCalledWith(expect.objectContaining({
      limit: 50,
      resourceType: IntentResourceType.ImageAssignment,
      resourceIds: ['a1', 'a2'],
    }));
  });

  it('rejects resourceId without resourceType', async () => {
    const { controller: c } = controller({});
    await expect(c.list(testActor(USER_ID), { resourceId: volumeId })).rejects.toThrow();
  });
});

describe('IntentsController GET /intents/:id and retry', () => {
  it('shows an intent to its requester, its resource owner and a capability holder', async () => {
    const mine = intent({ requestedBy: USER_ID });
    const { controller: byRequester } = controller({ findById: vi.fn().mockResolvedValue(mine) });
    await expect(byRequester.get(mine.id, testActor(USER_ID))).resolves.toMatchObject({ id: mine.id });

    const foreign = intent();
    const { controller: byOwner } = controller({
      findById: vi.fn().mockResolvedValue(foreign),
      authority: { ownerId: USER_ID, adminCapability: Capability.ManageVolumes },
    });
    await expect(byOwner.get(foreign.id, testActor(USER_ID))).resolves.toMatchObject({ id: foreign.id });

    const { controller: byCapability } = controller({ findById: vi.fn().mockResolvedValue(foreign) });
    await expect(byCapability.get(foreign.id, testActor(USER_ID, Capability.ManageVolumes)))
      .resolves.toMatchObject({ id: foreign.id });
  });

  it('hides other people\'s intents (403) and missing intents (404)', async () => {
    const foreign = intent();
    const { controller: c } = controller({ findById: vi.fn().mockResolvedValue(foreign) });
    await expect(c.get(foreign.id, testActor(USER_ID))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(c.get(foreign.id, testActor(USER_ID, Capability.ManageContainersAny)))
      .rejects.toBeInstanceOf(ForbiddenException);
    const missing = controller({ findById: vi.fn().mockResolvedValue(null) });
    await expect(missing.controller.get(foreign.id, testActor(USER_ID)))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('retries your own failed intent without any capability check', async () => {
    const own = intent({ requestedBy: USER_ID });
    const retried = intent({ id: '00000000-0000-4000-8000-000000000099', status: IntentStatus.Pending, failure: null, failureCode: null });
    const { controller: c, intents, access } = controller({
      findById: vi.fn().mockResolvedValue(own),
      retry: vi.fn().mockResolvedValue(retried),
    });
    const result = await c.retry(own.id, testActor(USER_ID), {});
    expect(result.id).toBe(retried.id);
    expect(intents.retry).toHaveBeenCalledWith(own.id);
    expect(access.runWithActorCapabilities).not.toHaveBeenCalled();
  });

  it('only retries failed intents', async () => {
    const pending = intent({ requestedBy: USER_ID, status: IntentStatus.Pending });
    const { controller: c, intents } = controller({ findById: vi.fn().mockResolvedValue(pending) });
    await expect(c.retry(pending.id, testActor(USER_ID), {})).rejects.toBeInstanceOf(ConflictException);
    expect(intents.retry).not.toHaveBeenCalled();
  });

  it('refuses to retry what you cannot see (403) and mutates nothing', async () => {
    const foreign = intent();
    const { controller: c, intents } = controller({ findById: vi.fn().mockResolvedValue(foreign) });
    await expect(c.retry(foreign.id, testActor(USER_ID), {})).rejects.toBeInstanceOf(ForbiddenException);
    expect(intents.retry).not.toHaveBeenCalled();
  });

  it('re-checks the row-specific capability inside retry for administrators of shared volumes', async () => {
    const foreign = intent();
    const retried = intent({ id: '00000000-0000-4000-8000-000000000099', status: IntentStatus.Pending, failure: null, failureCode: null });
    const authority = { ownerId: OTHER_ID, adminCapability: Capability.ManageSharedVolumes };
    const allowed = controller({
      findById: vi.fn().mockResolvedValue(foreign),
      retry: vi.fn().mockResolvedValue(retried),
      authority,
      liveCapabilities: new Set([Capability.ManageSharedVolumes]),
    });
    const result = await allowed.controller.retry(
      foreign.id,
      testActor(USER_ID, Capability.ManageSharedVolumes),
      {},
    );
    expect(allowed.intents.findById).toHaveBeenCalledTimes(2);
    expect(allowed.intents.retry).toHaveBeenCalledWith(foreign.id, {});
    expect(result.id).toBe(retried.id);

    // the capability was revoked between the guard and the retry: 404, nothing mutated
    const revoked = controller({
      findById: vi.fn().mockResolvedValue(foreign),
      authority,
      liveCapabilities: new Set(),
    });
    await expect(revoked.controller.retry(
      foreign.id,
      testActor(USER_ID, Capability.ManageSharedVolumes),
      {},
    )).rejects.toBeInstanceOf(NotFoundException);
    expect(revoked.intents.retry).not.toHaveBeenCalled();
  });
});

describe('IntentsController server-scoped visibility (old /admin/servers/:id/intents)', () => {
  const serverId = '00000000-0000-4000-8000-000000000003';
  const onServer = [
    intent({ id: '00000000-0000-4000-8000-0000000000c1', resourceType: IntentResourceType.Container }),
    intent({ id: '00000000-0000-4000-8000-0000000000c2', resourceType: IntentResourceType.Volume }),
    intent({ id: '00000000-0000-4000-8000-0000000000c3', resourceType: IntentResourceType.ImageAssignment }),
  ];

  it('lets ManageServers see every resource type on the server, with no type filter', async () => {
    const { controller: c, intents } = controller({
      list: vi.fn().mockResolvedValue({ items: onServer, nextCursor: null }),
      authority: { ownerId: null, adminCapability: Capability.ManageVolumes },
    });
    const result = await c.list(testActor(USER_ID, Capability.ManageServers), { scope: 'all', serverId });
    expect(result.items.map((item) => item.resourceType)).toEqual([
      IntentResourceType.Container,
      IntentResourceType.Volume,
      IntentResourceType.ImageAssignment,
    ]);
    expect(intents.list).toHaveBeenCalledWith(expect.objectContaining({ serverId, limit: 500 }));
    expect(intents.list.mock.calls[0]![0]).not.toHaveProperty('resourceTypes');
  });

  it('without serverId a ManageServers-only actor keeps the old /admin/intents type filter', async () => {
    const { controller: c, intents } = controller({});
    await c.list(testActor(USER_ID, Capability.ManageServers), { scope: 'all' });
    expect(intents.list).toHaveBeenCalledWith(expect.objectContaining({
      resourceTypes: [IntentResourceType.Server],
    }));
  });

  it('serverId does not widen access for actors without ManageServers', async () => {
    const { controller: c, intents } = controller({});
    await c.list(testActor(USER_ID, Capability.ManageContainersAny), { scope: 'all', serverId });
    expect(intents.list).toHaveBeenCalledWith(expect.objectContaining({
      serverId,
      resourceTypes: [IntentResourceType.Container],
    }));
    await expect(c.list(testActor(USER_ID), { scope: 'all', serverId }))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  it('per-resource scope=all lists match the old controllers: capability by kind, no more', async () => {
    const volume = controller({ authority: { ownerId: null, adminCapability: Capability.ManageVolumes } });
    await volume.controller.list(testActor(USER_ID, Capability.ManageVolumes), {
      scope: 'all', resourceType: IntentResourceType.Volume, resourceId: 'v1',
    });
    await expect(volume.controller.list(testActor(USER_ID, Capability.ManageSharedVolumes), {
      scope: 'all', resourceType: IntentResourceType.Volume, resourceId: 'v1',
    })).rejects.toBeInstanceOf(ForbiddenException);
    const container = controller({ authority: { ownerId: null, adminCapability: Capability.ManageContainersAny } });
    await expect(container.controller.list(testActor(USER_ID, Capability.ManageServers), {
      scope: 'all', resourceType: IntentResourceType.Container, resourceId: 'c1',
    })).rejects.toBeInstanceOf(ForbiddenException);
    const image = controller({ authority: { ownerId: null, adminCapability: Capability.ManageImages } });
    await image.controller.list(testActor(USER_ID, Capability.ManageImages), {
      scope: 'all', resourceType: IntentResourceType.ImageAssignment, resourceId: 'a1,a2',
    });
    expect(image.intents.list).toHaveBeenCalledOnce();
  });
});
