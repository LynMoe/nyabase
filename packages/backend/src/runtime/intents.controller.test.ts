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
import { AdminIntentsController } from './intents.controller.js';
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
  return {
    controller: new AdminIntentsController(
      intents as unknown as IntentRepository,
      access as unknown as AccessResolverService,
    ),
    intents,
  };
}

describe('AdminIntentsController capabilities', () => {
  it('requires any of the resource-type admin capabilities at class level', () => {
    expect(Reflect.getMetadata(ANY_CAPS_KEY, AdminIntentsController)).toEqual([
      Capability.ManageContainersAny,
      Capability.ManageVolumes,
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
      limit: 50,
      cursor: undefined,
      status: undefined,
      kind: undefined,
      resourceTypes: [
        IntentResourceType.Container,
        IntentResourceType.ImageAssignment,
        IntentResourceType.Server,
      ],
    });
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
