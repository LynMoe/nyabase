import { ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  Capability,
  IntentKind,
  IntentResourceType,
  IntentStatus,
  UserStatus,
} from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';
import { ANY_CAPS_KEY } from '../auth/decorators/require-caps.decorator.js';
import type { UserRecord } from '../domain/domain-records.js';
import {
  AdminIntentsController,
  adminIntentListOptions,
  listOptions,
} from './intents.controller.js';
import type { IntentRecord, IntentRepository } from './intent.repository.js';
import type { AccessResolverService } from '../access/access-resolver.service.js';

const actor: UserRecord = {
  id: '00000000-0000-4000-8000-0000000000aa',
  numericId: 1,
  username: 'operator',
  passwordHash: 'hash',
  displayName: 'Operator',
  status: UserStatus.Active,
  authVersion: 1,
  createdAt: new Date('2026-08-13T00:00:00.000Z'),
  updatedAt: new Date('2026-08-13T00:00:00.000Z'),
};

function intent(overrides: Partial<IntentRecord> = {}): IntentRecord {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    kind: IntentKind.VolumeEnsure,
    resourceType: IntentResourceType.Volume,
    resourceId: '00000000-0000-4000-8000-000000000002',
    serverId: '00000000-0000-4000-8000-000000000003',
    requestedBy: actor.id,
    request: {},
    targetGeneration: 1,
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

function controller(options: {
  capabilities: Set<Capability>;
  list?: ReturnType<typeof vi.fn>;
  findById?: ReturnType<typeof vi.fn>;
  retry?: ReturnType<typeof vi.fn>;
}) {
  const intents = {
    list: options.list ?? vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    findById: options.findById ?? vi.fn(),
    retry: options.retry ?? vi.fn(),
  };
  const access = {
    userCapabilitiesCurrent: vi.fn().mockResolvedValue(options.capabilities),
    runWithActorCapabilities: vi.fn(async (
      _actorId: string,
      required: Iterable<Capability>,
      work: (transaction: unknown) => Promise<unknown>,
    ) => {
      const missing = [...required].filter((capability) => !options.capabilities.has(capability));
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
  const database = {
    selectFrom: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      executeTakeFirst: vi.fn().mockResolvedValue({ shared_backend_id: null }),
      execute: vi.fn().mockResolvedValue([]),
    })),
  };
  return {
    controller: new AdminIntentsController(
      intents as unknown as IntentRepository,
      access as unknown as AccessResolverService,
      database as never,
    ),
    intents,
  };
}

describe('AdminIntentsController capabilities', () => {
  it('requires any of the resource-type admin capabilities at class level', () => {
    expect(Reflect.getMetadata(ANY_CAPS_KEY, AdminIntentsController)).toEqual([
      Capability.ManageContainersAny,
      Capability.ManageVolumes,
      Capability.ManageSharedVolumes,
      Capability.ManageServers,
      Capability.ManageImages,
      Capability.ManageCertificates,
    ]);
  });

  it('lists only intents whose resource type the actor can administer', async () => {
    const { controller: admin, intents } = controller({
      capabilities: new Set([
        Capability.ManageContainersAny,
        Capability.ManageServers,
        Capability.ManageImages,
      ]),
    });

    await admin.list({}, actor);

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

  it('forwards query resourceType and serverId only through adminIntentListOptions', async () => {
    const serverId = '00000000-0000-4000-8000-000000000003';
    const query = {
      resourceType: IntentResourceType.Container,
      serverId,
      status: IntentStatus.Pending,
    };
    expect(listOptions(query)).toEqual({
      limit: 50,
      cursor: undefined,
      status: IntentStatus.Pending,
      kind: undefined,
    });
    expect(listOptions({})).toEqual({
      limit: 50,
      cursor: undefined,
      status: undefined,
      kind: undefined,
    });
    expect(listOptions(query)).not.toHaveProperty('resourceType');
    expect(listOptions(query)).not.toHaveProperty('serverId');
    expect(() => listOptions({ ...query, limit: 500 })).toThrow();
    expect(adminIntentListOptions({ limit: 500 }).limit).toBe(500);
    expect(adminIntentListOptions(query)).toEqual({
      limit: 500,
      cursor: undefined,
      status: IntentStatus.Pending,
      kind: undefined,
      resourceType: IntentResourceType.Container,
      serverId,
    });
    expect(adminIntentListOptions({ ...query, limit: 50 })).toEqual({
      limit: 50,
      cursor: undefined,
      status: IntentStatus.Pending,
      kind: undefined,
      resourceType: IntentResourceType.Container,
      serverId,
    });

    const { controller: admin, intents } = controller({
      capabilities: new Set([
        Capability.ManageContainersAny,
        Capability.ManageServers,
      ]),
    });
    await admin.list(query, actor);
    expect(intents.list).toHaveBeenCalledWith({
      limit: 500,
      cursor: undefined,
      status: IntentStatus.Pending,
      kind: undefined,
      resourceType: IntentResourceType.Container,
      serverId,
      resourceTypes: undefined,
    });
  });

  it('returns an empty page when the actor cannot administer the requested resourceType', async () => {
    const { controller: admin, intents } = controller({
      capabilities: new Set([Capability.ManageContainersAny]),
    });

    const result = await admin.list({ resourceType: IntentResourceType.Volume }, actor);

    expect(result).toEqual({ items: [], nextCursor: null });
    expect(intents.list).not.toHaveBeenCalled();
  });

  it('hides get and retry for intents outside the actor capabilities', async () => {
    const volumeIntent = intent();
    const { controller: admin, intents } = controller({
      capabilities: new Set([Capability.ManageContainersAny]),
      findById: vi.fn().mockResolvedValue(volumeIntent),
      retry: vi.fn(),
    });

    await expect(admin.get(volumeIntent.id, actor))
      .rejects.toBeInstanceOf(NotFoundException);
    await expect(admin.retry(volumeIntent.id, actor, {}))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(intents.retry).not.toHaveBeenCalled();
  });

  it('re-checks the resource-type capability inside retry before mutating', async () => {
    const volumeIntent = intent();
    const retried = intent({
      id: '00000000-0000-4000-8000-000000000099',
      status: IntentStatus.Pending,
      failureCode: null,
      failure: null,
      settledAt: null,
    });
    const { controller: admin, intents } = controller({
      capabilities: new Set([Capability.ManageVolumes]),
      findById: vi.fn().mockResolvedValue(volumeIntent),
      retry: vi.fn().mockResolvedValue(retried),
    });

    const result = await admin.retry(volumeIntent.id, actor, {});

    expect(intents.findById).toHaveBeenCalledTimes(2);
    expect(intents.retry).toHaveBeenCalledWith(volumeIntent.id, {});
    expect(result.id).toBe(retried.id);
    expect(result.status).toBe(IntentStatus.Pending);
  });
});
