import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  IntentKind,
  IntentResourceType,
  IntentStatus,
  Role,
  roleAtLeast,
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
    ...overrides,
  };
}


interface Authority { ownerId: string | null }
/** `missing`: the resource was deleted, so the registry knows no authority for it. */
type AuthorityOption = Authority | 'missing';

function controller(options: {
  list?: ReturnType<typeof vi.fn>;
  findById?: ReturnType<typeof vi.fn>;
  retry?: ReturnType<typeof vi.fn>;
  /** Live role as seen by the in-transaction re-check. */
  liveRole?: Role;
  authority?: AuthorityOption;
}) {
  const intents = {
    list: options.list ?? vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    findById: options.findById ?? vi.fn(),
    retry: options.retry ?? vi.fn(),
  };
  const live = options.liveRole ?? Role.User;
  const access = {
    runWithActorRole: vi.fn(async (
      _actorId: string,
      required: Role,
      work: (transaction: unknown) => Promise<unknown>,
    ) => {
      if (!roleAtLeast(live, required)) {
        throw new ForbiddenException({
          code: 'ROLE_REQUIRED',
          message: 'The actor does not hold the required role',
        });
      }
      return work({});
    }),
  };
  const authority = options.authority ?? { ownerId: null };
  const registry = {
    forResource: vi.fn(() => ({
      resourceAuthorities: vi.fn(async (ids: readonly string[]) =>
        new Map(authority === 'missing' ? [] : ids.map((id) => [id, authority]))),
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

describe('IntentsController GET /intents', () => {
  it('scope=all lists only intents whose resource type the actor can administer', async () => {
    const { controller: c, intents } = controller({});
    const operator = testActor(USER_ID, Role.Operator);

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

  it('scope=all needs the operator role (403 otherwise)', async () => {
    const { controller: c, intents } = controller({});
    await expect(c.list(testActor(USER_ID), { scope: 'all' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(intents.list).not.toHaveBeenCalled();
  });

  it('scope=all for an admin also lists volume intents', async () => {
    const { controller: c, intents } = controller({});
    await c.list(testActor(USER_ID, Role.Admin), { scope: 'all' });
    expect(intents.list).toHaveBeenCalledWith(expect.objectContaining({
      resourceTypes: [
        IntentResourceType.Container,
        IntentResourceType.Volume,
        IntentResourceType.ImageAssignment,
        IntentResourceType.Server,
      ],
    }));
  });

  it('forwards filters and an explicit limit', async () => {
    const serverId = '00000000-0000-4000-8000-000000000003';
    const { controller: c, intents } = controller({});
    await c.list(testActor(USER_ID, Role.Operator), {
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
      testActor(USER_ID, Role.Operator),
      { scope: 'all', resourceType: IntentResourceType.Volume },
    );
    expect(result).toEqual({ items: [], nextCursor: null });
    expect(intents.list).not.toHaveBeenCalled();
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
    const owned = controller({ authority: { ownerId: USER_ID } });
    await owned.controller.list(testActor(USER_ID), {
      resourceType: IntentResourceType.Volume,
      resourceId: volumeId,
    });
    expect(owned.intents.list).toHaveBeenCalledWith(expect.objectContaining({
      resourceType: IntentResourceType.Volume,
      resourceIds: [volumeId],
    }));

    const foreign = controller({ authority: { ownerId: OTHER_ID } });
    await expect(foreign.controller.list(testActor(USER_ID), {
      resourceType: IntentResourceType.Volume,
      resourceId: volumeId,
    })).rejects.toBeInstanceOf(NotFoundException);
    // holding the role does not widen scope=mine
    await expect(foreign.controller.list(testActor(USER_ID, Role.Admin), {
      resourceType: IntentResourceType.Volume,
      resourceId: volumeId,
    })).rejects.toBeInstanceOf(NotFoundException);
    expect(foreign.intents.list).not.toHaveBeenCalled();
  });

  it('scope=all for a resource needs that resource\'s role and accepts several ids', async () => {
    const { controller: c, intents } = controller({
      authority: { ownerId: OTHER_ID },
    });
    await expect(c.list(testActor(USER_ID), {
      scope: 'all',
      resourceType: IntentResourceType.ImageAssignment,
      resourceId: 'a1,a2',
    })).rejects.toBeInstanceOf(ForbiddenException);
    await c.list(testActor(USER_ID, Role.Operator), {
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
  it('shows an intent to its resource owner whatever their role, and to its requester only with the role', async () => {
    const mine = intent({ requestedBy: USER_ID });
    const { controller: byRequester } = controller({
      findById: vi.fn().mockResolvedValue(mine),
      authority: { ownerId: USER_ID },
    });
    await expect(byRequester.get(mine.id, testActor(USER_ID))).resolves.toMatchObject({ id: mine.id });

    const foreign = intent();
    const { controller: byOwner } = controller({
      findById: vi.fn().mockResolvedValue(foreign),
      authority: { ownerId: USER_ID },
    });
    await expect(byOwner.get(foreign.id, testActor(USER_ID, Role.Admin))).resolves.toMatchObject({ id: foreign.id });
  });

  it('shows someone else\'s intent only with scope=all and the type role', async () => {
    const foreign = intent();
    const { controller: c } = controller({ findById: vi.fn().mockResolvedValue(foreign) });
    // the role alone does not widen the default scope
    await expect(c.get(foreign.id, testActor(USER_ID, Role.Admin))).rejects.toBeInstanceOf(NotFoundException);
    await expect(c.get(foreign.id, testActor(USER_ID), 'all')).rejects.toBeInstanceOf(ForbiddenException);
    // volume intents are admin-only
    await expect(c.get(foreign.id, testActor(USER_ID, Role.Operator), 'all'))
      .rejects.toBeInstanceOf(ForbiddenException);
    await expect(c.get(foreign.id, testActor(USER_ID, Role.Admin), 'all'))
      .resolves.toMatchObject({ id: foreign.id });
  });

  it('hides other people\'s intents and missing intents with 404', async () => {
    const foreign = intent();
    const { controller: c } = controller({ findById: vi.fn().mockResolvedValue(foreign) });
    await expect(c.get(foreign.id, testActor(USER_ID))).rejects.toBeInstanceOf(NotFoundException);
    const missing = controller({ findById: vi.fn().mockResolvedValue(null) });
    await expect(missing.controller.get(foreign.id, testActor(USER_ID)))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('hides an intent you requested on someone else\'s resource once you lost the role', async () => {
    // An operator issued it with scope=all against another user's container, then was demoted.
    const issued = intent({ requestedBy: USER_ID, resourceType: IntentResourceType.Container });
    const retried = intent({ id: '00000000-0000-4000-8000-000000000099', status: IntentStatus.Pending, failure: null, failureCode: null });
    const demoted = controller({
      findById: vi.fn().mockResolvedValue(issued),
      retry: vi.fn().mockResolvedValue(retried),
      authority: { ownerId: OTHER_ID },
    });
    await expect(demoted.controller.get(issued.id, testActor(USER_ID))).rejects.toBeInstanceOf(NotFoundException);
    await expect(demoted.controller.retry(issued.id, testActor(USER_ID), {}))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(demoted.intents.retry).not.toHaveBeenCalled();

    // Still an operator: visible, and the retry re-checks the role in a transaction.
    const operator = controller({
      findById: vi.fn().mockResolvedValue(issued),
      retry: vi.fn().mockResolvedValue(retried),
      authority: { ownerId: OTHER_ID },
      liveRole: Role.Operator,
    });
    await expect(operator.controller.get(issued.id, testActor(USER_ID, Role.Operator)))
      .resolves.toMatchObject({ id: issued.id });
    await expect(operator.controller.retry(issued.id, testActor(USER_ID, Role.Operator), {}))
      .resolves.toMatchObject({ id: retried.id });
    expect(operator.access.runWithActorRole).toHaveBeenCalled();

    // Demoted between the guard and the retry: 404, nothing mutated.
    const raced = controller({
      findById: vi.fn().mockResolvedValue(issued),
      authority: { ownerId: OTHER_ID },
      liveRole: Role.User,
    });
    await expect(raced.controller.retry(issued.id, testActor(USER_ID, Role.Operator), {}))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(raced.intents.retry).not.toHaveBeenCalled();
  });

  it('keeps the intents of a resource you deleted visible to you', async () => {
    const deleted = intent({ requestedBy: USER_ID, kind: IntentKind.ContainerDelete, resourceType: IntentResourceType.Container });
    const gone = controller({
      findById: vi.fn().mockResolvedValue(deleted),
      list: vi.fn().mockResolvedValue({ items: [deleted], nextCursor: null }),
      authority: 'missing',
    });
    await expect(gone.controller.get(deleted.id, testActor(USER_ID))).resolves.toMatchObject({ id: deleted.id });
    await expect(gone.controller.list(testActor(USER_ID), {})).resolves.toMatchObject({ items: [{ id: deleted.id }] });
    const stranger = controller({ findById: vi.fn().mockResolvedValue(deleted), authority: 'missing' });
    await expect(stranger.controller.get(deleted.id, testActor(OTHER_ID))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('drops intents you requested on someone else\'s resource from your list once you lost the role', async () => {
    const issued = intent({ requestedBy: USER_ID, resourceType: IntentResourceType.Container });
    const list = () => vi.fn().mockResolvedValue({ items: [issued], nextCursor: null });
    const demoted = controller({ list: list(), authority: { ownerId: OTHER_ID } });
    await expect(demoted.controller.list(testActor(USER_ID), {})).resolves.toMatchObject({ items: [] });
    const owner = controller({ list: list(), authority: { ownerId: USER_ID } });
    await expect(owner.controller.list(testActor(USER_ID), {})).resolves.toMatchObject({ items: [{ id: issued.id }] });
    const operator = controller({ list: list(), authority: { ownerId: OTHER_ID } });
    await expect(operator.controller.list(testActor(USER_ID, Role.Operator), {}))
      .resolves.toMatchObject({ items: [{ id: issued.id }] });
  });

  it('retries a failed intent on your own resource without any role check', async () => {
    const own = intent({ requestedBy: USER_ID });
    const retried = intent({ id: '00000000-0000-4000-8000-000000000099', status: IntentStatus.Pending, failure: null, failureCode: null });
    const { controller: c, intents, access } = controller({
      findById: vi.fn().mockResolvedValue(own),
      retry: vi.fn().mockResolvedValue(retried),
      authority: { ownerId: USER_ID },
    });
    const result = await c.retry(own.id, testActor(USER_ID), {});
    expect(result.id).toBe(retried.id);
    expect(intents.retry).toHaveBeenCalledWith(own.id);
    expect(access.runWithActorRole).not.toHaveBeenCalled();
  });

  it('only retries failed intents', async () => {
    const pending = intent({ requestedBy: USER_ID, status: IntentStatus.Pending });
    const { controller: c, intents } = controller({
      findById: vi.fn().mockResolvedValue(pending),
      authority: { ownerId: USER_ID },
    });
    await expect(c.retry(pending.id, testActor(USER_ID), {})).rejects.toBeInstanceOf(ConflictException);
    expect(intents.retry).not.toHaveBeenCalled();
  });

  it('refuses to retry what you cannot see (404) and mutates nothing, even as an operator without scope=all', async () => {
    const foreign = intent({ resourceType: IntentResourceType.Container });
    const { controller: c, intents } = controller({ findById: vi.fn().mockResolvedValue(foreign) });
    await expect(c.retry(foreign.id, testActor(USER_ID), {})).rejects.toBeInstanceOf(NotFoundException);
    await expect(c.retry(foreign.id, testActor(USER_ID, Role.Operator), {}))
      .rejects.toBeInstanceOf(NotFoundException);
    await expect(c.retry(foreign.id, testActor(USER_ID), {}, 'all')).rejects.toBeInstanceOf(ForbiddenException);
    expect(intents.retry).not.toHaveBeenCalled();
  });

  it('retries with scope=all under a transaction that re-checks the role', async () => {
    const foreign = intent({ resourceType: IntentResourceType.Container });
    const retried = intent({ id: '00000000-0000-4000-8000-000000000099', status: IntentStatus.Pending, failure: null, failureCode: null });
    const allowed = controller({
      findById: vi.fn().mockResolvedValue(foreign),
      retry: vi.fn().mockResolvedValue(retried),
      liveRole: Role.Operator,
    });
    const result = await allowed.controller.retry(
      foreign.id,
      testActor(USER_ID, Role.Operator),
      {},
      'all',
    );
    expect(allowed.intents.findById).toHaveBeenCalledTimes(2);
    expect(allowed.intents.retry).toHaveBeenCalledWith(foreign.id, {});
    expect(result.id).toBe(retried.id);

    // the role was revoked between the guard and the retry: 404, nothing mutated
    const revoked = controller({
      findById: vi.fn().mockResolvedValue(foreign),
      liveRole: Role.User,
    });
    await expect(revoked.controller.retry(
      foreign.id,
      testActor(USER_ID, Role.Operator),
      {},
      'all',
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

  it('lets an operator see every resource type on the server, with no type filter', async () => {
    const { controller: c, intents } = controller({
      list: vi.fn().mockResolvedValue({ items: onServer, nextCursor: null }),
      authority: { ownerId: null },
    });
    const result = await c.list(testActor(USER_ID, Role.Operator), { scope: 'all', serverId });
    expect(result.items.map((item) => item.resourceType)).toEqual([
      IntentResourceType.Container,
      IntentResourceType.Volume,
      IntentResourceType.ImageAssignment,
    ]);
    expect(intents.list).toHaveBeenCalledWith(expect.objectContaining({ serverId, limit: 500 }));
    expect(intents.list.mock.calls[0]![0]).not.toHaveProperty('resourceTypes');
  });

  it('without a serverId an operator keeps the resource type filter', async () => {
    const { controller: c, intents } = controller({});
    await c.list(testActor(USER_ID, Role.Operator), { scope: 'all' });
    expect(intents.list).toHaveBeenCalledWith(expect.objectContaining({
      resourceTypes: [
        IntentResourceType.Container,
        IntentResourceType.ImageAssignment,
        IntentResourceType.Server,
      ],
    }));
  });

  it('serverId does not widen access for users', async () => {
    const { controller: c } = controller({});
    await expect(c.list(testActor(USER_ID), { scope: 'all', serverId }))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  it('per-resource scope=all lists follow the role by kind, no more', async () => {
    const volume = controller({ authority: { ownerId: null } });
    await volume.controller.list(testActor(USER_ID, Role.Admin), {
      scope: 'all', resourceType: IntentResourceType.Volume, resourceId: 'v1',
    });
    await expect(volume.controller.list(testActor(USER_ID, Role.Operator), {
      scope: 'all', resourceType: IntentResourceType.Volume, resourceId: 'v1',
    })).rejects.toBeInstanceOf(ForbiddenException);
    const container = controller({ authority: { ownerId: null } });
    await expect(container.controller.list(testActor(USER_ID), {
      scope: 'all', resourceType: IntentResourceType.Container, resourceId: 'c1',
    })).rejects.toBeInstanceOf(ForbiddenException);
    const image = controller({ authority: { ownerId: null } });
    await image.controller.list(testActor(USER_ID, Role.Operator), {
      scope: 'all', resourceType: IntentResourceType.ImageAssignment, resourceId: 'a1,a2',
    });
    expect(image.intents.list).toHaveBeenCalledOnce();
  });
});
