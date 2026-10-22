import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import {
  ContainerPowerIntent,
  FailureCode,
  ServerStatus,
  UserStatus,
  type CreateContainerRequest,
  Role,
} from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { IntentRepository } from '../reconcile/intent.repository.js';
import { ContainerReconciler } from './container-reconciler.service.js';
import { ContainerReconcileStore } from './container-reconcile.store.js';
import { ContainerControlRepository } from './container-control.repository.js';
import { ContainerControlService } from './container-control.service.js';
import { makeContainerControlService } from './container-services.test-helper.js';
import { ImagesService } from '../images/images.service.js';
import { IpPoolsRepository } from '../ip-pools/ip-pools.repository.js';
import { isGpuOccupiedSqlError } from '../gpu/admit.js';
import { GpuClaimsRepository } from '../gpu/gpu-claims.repository.js';
import { noopWake } from '../reconcile/reconcile-wake.test-helper.js';
import { testActor } from '../iam/actor.test-helper.js';
import { ContainerSshConvergenceService, IncusContainerSshStateAdapter } from './container-ssh.js';
import { AccessResolverService } from '../iam/access-resolver.service.js';
import {
  days,
  grantPool,
  grantServer,
  seedAttachment,
  seedUser,
  seedVolume,
} from '../iam/access.pg-test-helper.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;
const IMAGE_FINGERPRINT = 'a'.repeat(64);

interface Fixture {
  userId: string;
  serverId: string;
  poolId: string;
  imageId: string;
  fingerprint: string;
}

interface SeedOptions {
  cidr?: string;
  gateway?: string;
  reservedIps?: string[];
  preflightStatus?: 'not_run' | 'running' | 'passed' | 'failed';
  serverStatus?: ServerStatus;
  poolTotalBytes?: number;
  overcommitRatio?: number;
  minimumRootSizeBytes?: number;
}

interface GrantOptions {
  diskBytes: number | null;
  gpuPciAddresses?: string[];
}

describePg('PostgreSQL container create admission and capacity', () => {
  it('rejects container create below an admin-filled min_root_size_bytes floor', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const fixture = await seedFixture(database, {
        poolTotalBytes: 10_000,
        minimumRootSizeBytes: 500,
      });
      const service = containerService(database, { diskBytes: 10_000 });
      await expectCode(
        service.service.create(testActor(fixture.userId), request(fixture, 'below-min-root', {
          rootSizeBytes: 400,
        })),
        FailureCode.RootSizeBelowImageMinimum,
      );
      expect(await database.selectFrom('control.containers').select('id').execute()).toEqual([]);
      expect(await database.selectFrom('control.intents').select('id').execute()).toEqual([]);
    });
  });

  it('requires an active assignment whose observed fingerprint matches the image', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const fixture = await seedFixture(database);
      const service = containerService(database, { diskBytes: 10_000 });
      await database.updateTable('infra.image_server_assignments')
        .set({ lifecycle_phase: 'provisioning' })
        .where('image_id', '=', fixture.imageId)
        .where('server_id', '=', fixture.serverId)
        .execute();

      await expectCode(
        service.service.create(testActor(fixture.userId), request(fixture, 'inactive-assignment')),
        FailureCode.ImageAssignmentFingerprintMismatch,
      );
      await database.updateTable('infra.image_server_assignments')
        .set({ lifecycle_phase: 'active', observed_fingerprint: 'b'.repeat(64) })
        .where('image_id', '=', fixture.imageId)
        .where('server_id', '=', fixture.serverId)
        .execute();

      await expectCode(
        service.service.create(testActor(fixture.userId), request(fixture, 'fingerprint-mismatch')),
        FailureCode.ImageAssignmentFingerprintMismatch,
      );
      expect(await database.selectFrom('control.containers').select('id').execute()).toEqual([]);
      expect(await database.selectFrom('control.intents').select('id').execute()).toEqual([]);
    });
  });

  it('rejects failed preflight and a missing server system pool inside the transaction', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const fixture = await seedFixture(database, { preflightStatus: 'failed' });
      const service = containerService(database, { diskBytes: 10_000 });

      await expectCode(
        service.service.create(testActor(fixture.userId), request(fixture, 'preflight-failed')),
        FailureCode.PreflightFailed,
      );

      await database.updateTable('infra.servers')
        .set({ preflight_status: 'passed', system_pool_id: null })
        .where('id', '=', fixture.serverId)
        .execute();
      await expectCode(
        service.service.create(testActor(fixture.userId), request(fixture, 'system-pool-missing')),
        FailureCode.StoragePoolExhausted,
      );
      expect(await database.selectFrom('control.containers').select('id').execute()).toEqual([]);
    });
  });

  it('does not grow settled container intents across repeated full scans', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const fixture = await seedFixture(database);
      const service = containerService(database, { diskBytes: 10_000 });
      const created = await service.service.create(
        testActor(fixture.userId),
        request(fixture, 'scan-idempotent'),
      );
      const intents = new IntentRepository(database, noopWake());
      await intents.settleForObservedRevision(
        'container',
        created.resourceId,
        1,
        { outcome: 'succeeded', placementServerId: fixture.serverId },
      );
      const reconciler = new ContainerReconciler(new ContainerReconcileStore(database, intents),
        new IncusContainerSshStateAdapter(),
        { notify: vi.fn() } as never,
        { log: vi.fn() } as never,
        { register: vi.fn() } as never,
        { resolve: vi.fn().mockResolvedValue([0]), preview: vi.fn().mockResolvedValue([0]), releaseIdle: vi.fn() } as never,
        { get: vi.fn().mockReturnValue(1_000) } as never,
        { onChange: vi.fn() } as never,
        { wake: vi.fn() } as never,
      );
      const client = {
        listInstances: vi.fn().mockResolvedValue({ metadata: [] }),
      };

      await reconciler.scan(fixture.serverId, client as never, new AbortController().signal);
      await reconciler.scan(fixture.serverId, client as never, new AbortController().signal);

      expect(await database.selectFrom('control.intents')
        .select('id')
        .where('resource_id', '=', created.resourceId)
        .execute()).toHaveLength(2);
    });
  });

  it('enforces independent server quota and storage-pool overcommit capacity', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const fixture = await seedFixture(database, {
        poolTotalBytes: 10_000,
        minimumRootSizeBytes: 1,
      });
      const service = containerService(database, { diskBytes: 150 });
      await service.service.create(testActor(fixture.userId), request(fixture, 'quota-first', {
        rootSizeBytes: 100,
      }));
      await expectCode(
        service.service.create(testActor(fixture.userId), request(fixture, 'quota-second', {
          rootSizeBytes: 60,
        })),
        FailureCode.StorageGrantExceeded,
      );
    });

    await withPostgresTestDatabase(async ({ database }) => {
      const fixture = await seedFixture(database, {
        poolTotalBytes: 150,
        minimumRootSizeBytes: 1,
      });
      const service = containerService(database, { diskBytes: 10_000 });
      await service.service.create(testActor(fixture.userId), request(fixture, 'pool-first', {
        rootSizeBytes: 100,
      }));
      await expectCode(
        service.service.create(testActor(fixture.userId), request(fixture, 'pool-second', {
          rootSizeBytes: 60,
        })),
        FailureCode.StoragePoolExhausted,
      );
    });
  });

  it('serializes concurrent creates so exactly one wins the final pool capacity race', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const fixture = await seedFixture(database, {
        poolTotalBytes: 100,
        overcommitRatio: 1.5,
        minimumRootSizeBytes: 1,
      });
      const service = containerService(database, { diskBytes: 10_000 });
      const results = await Promise.allSettled([
        service.service.create(testActor(fixture.userId), request(fixture, 'concurrent-a', { rootSizeBytes: 100 })),
        service.service.create(testActor(fixture.userId), request(fixture, 'concurrent-b', { rootSizeBytes: 100 })),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(await database.selectFrom('control.containers').select('id').execute()).toHaveLength(1);
      expect(await database.selectFrom('control.intents').select('id').execute()).toHaveLength(1);
    });
  });

  it('serializes image deletion with container creation on the image row', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const fixture = await seedFixture(database);
      const operatorId = await seedUser(database, undefined, UserStatus.Active, Role.Operator);
      const containerState = containerService(database, { diskBytes: 10_000 });
      const imageIntents = {
        ensurePending: vi.fn(async (input: {
          resourceId: string;
          serverId: string;
          targetRevision: number;
          kind: string;
        }) => ({
          id: randomUUID(),
          kind: input.kind,
          resourceType: 'image_assignment' as const,
          resourceId: input.resourceId,
          serverId: input.serverId,
          requestedBy: fixture.userId,
          request: null,
          targetRevision: input.targetRevision,
          baseline: null,
          status: 'pending' as const,
          failureCode: null,
          failure: null,
          attemptCount: 0,
          nextAttemptAt: null,
          createdAt: new Date().toISOString(),
          settledAt: null,
        })),
      };
      const images = new ImagesService(
        database,
        new PgTransactionManager(database),
        {} as never,
        { append: vi.fn().mockResolvedValue(undefined) } as never,
        imageIntents as never,
        {} as never,
      );

      const [deleteResult, createResult] = await Promise.all([
        images.delete(operatorId, fixture.imageId).then(
          (value) => ({ status: 'fulfilled' as const, value }),
          (reason) => ({ status: 'rejected' as const, reason }),
        ),
        containerState.service.create(testActor(fixture.userId), request(fixture, 'image-delete-race')).then(
          (value) => ({ status: 'fulfilled' as const, value }),
          (reason) => ({ status: 'rejected' as const, reason }),
        ),
      ]);

      expect(deleteResult.status === 'fulfilled' && createResult.status === 'fulfilled').toBe(false);
      if (deleteResult.status === 'fulfilled') {
        expect(createResult.status).toBe('rejected');
        const reason = (createResult as { status: 'rejected'; reason: { response: { code: string } } }).reason;
        expect(reason.response.code).toBe(FailureCode.ImageNotAvailable);
      } else {
        expect(createResult.status).toBe('fulfilled');
        const reason = (deleteResult as { status: 'rejected'; reason: { response: { code: string } } }).reason;
        expect(reason.response.code).toBe('IMAGE_IN_USE');
      }

      const image = await database.selectFrom('infra.images')
        .select(['is_active', 'deleting'])
        .where('id', '=', fixture.imageId)
        .executeTakeFirstOrThrow();
      const retained = await database.selectFrom('control.containers')
        .select('id')
        .where('image_id', '=', fixture.imageId)
        .where('lifecycle_phase', 'not in', ['failed', 'deleting'])
        .execute();
      if (image.deleting) expect(retained).toHaveLength(0);
    });
  });

  it('uses greatest(root_size_bytes, root_size_pending_bytes) and excludes shared volume bytes from A/B', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const fixture = await seedFixture(database, {
        poolTotalBytes: 10_000,
        minimumRootSizeBytes: 1,
      });
      const serviceState = containerService(database, { diskBytes: 10_000 });

      const first = await serviceState.service.create(
        testActor(fixture.userId),
        request(fixture, 'pending-larger', { rootSizeBytes: 100 }),
      );
      await database.updateTable('control.containers')
        .set({ root_size_pending_bytes: 300 })
        .where('id', '=', first.resourceId)
        .execute();

      const second = await serviceState.service.create(
        testActor(fixture.userId),
        request(fixture, 'pending-smaller', { rootSizeBytes: 500 }),
      );
      await database.updateTable('control.containers')
        .set({ root_size_pending_bytes: 200 })
        .where('id', '=', second.resourceId)
        .execute();

      await seedSharedVolume(database, fixture, 9_000_000);
      serviceState.access.resolveContainerCreateAccessInTransaction.mockResolvedValue({
        grant: grant({ diskBytes: 1_000 }),
        imageAvailable: true,
      });

      const third = await serviceState.service.create(
        testActor(fixture.userId),
        request(fixture, 'max-and-shared-excluded', { rootSizeBytes: 100 }),
      );
      expect(third.status).toBe('pending');
      expect(await database.selectFrom('control.containers').select('id').execute()).toHaveLength(3);
    });
  });
});

const GPU_A = '0000:41:00.0';
const GPU_A_CANONICAL = '00000000:41:00.0';
const GPU_B = '0000:42:00.0';
const GPU_B_CANONICAL = '00000000:42:00.0';

describePg('PostgreSQL GPU claims', () => {
  it('inserts the container before claims and maps UNIQUE collisions', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const fixture = await seedFixture(database, { poolTotalBytes: 10_000 });
      const harness = gpuHarness(database, { diskBytes: 10_000, gpuPciAddresses: [GPU_A, GPU_B] });
      await enableGpu(database, fixture);

      const first = await harness.service.create(
        testActor(fixture.userId),
        request(fixture, 'claim-first', { gpuPciAddresses: [GPU_A] }),
      );
      const container = await database.selectFrom('control.containers')
        .select(['id', 'gpu_state'])
        .where('id', '=', first.resourceId)
        .executeTakeFirstOrThrow();
      const claims = await database.selectFrom('control.container_gpu_claims')
        .select(['container_id', 'pci_address'])
        .where('server_id', '=', fixture.serverId)
        .execute();
      expect(claims).toEqual([{
        container_id: container.id,
        pci_address: GPU_A_CANONICAL,
      }]);
      expect(container.gpu_state).toEqual({
        nvidiaRuntime: true,
        pciAddresses: [GPU_A_CANONICAL],
      });

      await expectCode(
        harness.service.create(
          testActor(fixture.userId),
          request(fixture, 'claim-collision', { gpuPciAddresses: [GPU_A] }),
        ),
        FailureCode.GpuDeviceClaimed,
      );
    });
  });

  it('rejects GPU payload while disabled and occupancy-blocks disable', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const fixture = await seedFixture(database, { poolTotalBytes: 10_000 });
      const harness = gpuHarness(database, { diskBytes: 10_000, gpuPciAddresses: [GPU_A, GPU_B] });

      await expectCode(
        harness.service.create(
          testActor(fixture.userId),
          request(fixture, 'not-enabled', { gpuPciAddresses: [GPU_A] }),
        ),
        FailureCode.GpuNotEnabled,
      );

      await enableGpu(database, fixture);
      const created = await harness.service.create(
        testActor(fixture.userId),
        request(fixture, 'occupied-disable', { gpuPciAddresses: [GPU_B] }),
      );
      expect(created.resourceId).toBeTruthy();
      try {
        await database.updateTable('infra.servers')
          .set({ gpu_enabled: false })
          .where('id', '=', fixture.serverId)
          .execute();
        throw new Error('expected occupancy block');
      } catch (error) {
        expect(isGpuOccupiedSqlError(error)).toBe(true);
      }
    });
  });

  it('rejects a card outside the server grant', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const fixture = await seedFixture(database, { poolTotalBytes: 10_000 });
      const harness = gpuHarness(database, { diskBytes: 10_000, gpuPciAddresses: [GPU_A] });
      await enableGpu(database, fixture);

      await expectCode(
        harness.service.create(
          testActor(fixture.userId),
          request(fixture, 'outside-grant', { gpuPciAddresses: [GPU_B] }),
        ),
        FailureCode.PermissionDenied,
      );
    });
  });

  it('releases claims on failed phase so a later create can reuse the card', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const fixture = await seedFixture(database, { poolTotalBytes: 10_000 });
      const harness = gpuHarness(database, { diskBytes: 10_000, gpuPciAddresses: [GPU_A] });
      await enableGpu(database, fixture);

      const first = await harness.service.create(
        testActor(fixture.userId),
        request(fixture, 'failed-release', { gpuPciAddresses: [GPU_A] }),
      );
      await database.updateTable('control.containers')
        .set({ lifecycle_phase: 'failed', failure_code: 'RESOURCE_NEEDS_ATTENTION' })
        .where('id', '=', first.resourceId)
        .execute();
      expect(
        await database.selectFrom('control.container_gpu_claims')
          .select('container_id')
          .where('container_id', '=', first.resourceId)
          .execute(),
      ).toEqual([]);

      const reused = await harness.service.create(
        testActor(fixture.userId),
        request(fixture, 'failed-reuse', { gpuPciAddresses: [GPU_A] }),
      );
      const claims = await database.selectFrom('control.container_gpu_claims')
        .select(['container_id', 'pci_address'])
        .where('pci_address', '=', GPU_A_CANONICAL)
        .execute();
      expect(claims).toEqual([{ container_id: reused.resourceId, pci_address: GPU_A_CANONICAL }]);
    });
  });

  it('mutates claims for a stopped container', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const fixture = await seedFixture(database, { poolTotalBytes: 10_000 });
      const harness = gpuHarness(database, { diskBytes: 10_000 });
      await enableGpu(database, fixture);

      const created = await harness.service.create(
        testActor(fixture.userId),
        request(fixture, 'mutate-later'),
      );
      await database.updateTable('control.container_ssh_routes')
        .set({ instance_status: 'Stopped' })
        .where('container_id', '=', created.resourceId)
        .execute();

      await database.updateTable('iam.users').set({ role: Role.Operator })
        .where('id', '=', fixture.userId).execute();
      await harness.service.mutateGpus(
        testActor(fixture.userId, Role.Operator),
        created.resourceId,
        { pciAddresses: [GPU_B] },
        'all',
      );
      const claims = await database.selectFrom('control.container_gpu_claims')
        .select(['container_id', 'pci_address'])
        .where('container_id', '=', created.resourceId)
        .execute();
      expect(claims).toEqual([{ container_id: created.resourceId, pci_address: GPU_B_CANONICAL }]);
      const container = await database.selectFrom('control.containers')
        .select('gpu_state')
        .where('id', '=', created.resourceId)
        .executeTakeFirstOrThrow();
      expect(container.gpu_state).toEqual({
        nvidiaRuntime: true,
        pciAddresses: [GPU_B_CANONICAL],
      });
    });
  });
});

describePg('PostgreSQL container actor authorization', () => {
  it('shows a container to its owner, to an operator only with scope=all, and hides it from others', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const fixture = await seedFixture(database);
      const { service } = containerService(database, { diskBytes: 10_000 });
      const created = await service.create(testActor(fixture.userId), request(fixture, 'authz'));
      const containerId = created.resourceId;
      const owner = testActor(fixture.userId);
      const operator = testActor(cryptoId(), Role.Operator);
      const stranger = testActor(cryptoId());

      await expect(service.get(owner, containerId)).resolves.toMatchObject({ id: containerId });
      await expect(service.get(operator, containerId, 'all')).resolves.toMatchObject({ id: containerId });
      await expect(service.get(operator, containerId)).rejects.toMatchObject({ status: 404 });
      await expect(service.get(stranger, containerId)).rejects.toMatchObject({ status: 404 });
      await expect(service.get(stranger, containerId, 'all')).rejects.toMatchObject({ status: 403 });
      await expect(service.action(stranger, containerId, 'stop')).rejects.toMatchObject({ status: 404 });
      await expect(service.action(operator, containerId, 'stop')).rejects.toMatchObject({ status: 404 });
      await expect(service.updateLimits(stranger, containerId, { memBytes: 1 }))
        .rejects.toMatchObject({ status: 404 });

      // scope=mine only returns the caller's rows; scope=all needs the operator role.
      expect((await service.list(owner, {})).map((row) => row.id)).toEqual([containerId]);
      expect(await service.list(stranger, {})).toEqual([]);
      expect((await service.list(operator, { scope: 'all' })).map((row) => row.id))
        .toEqual([containerId]);
      expect(await service.list(operator, {})).toEqual([]);
      await expect(service.list(stranger, { scope: 'all' })).rejects.toMatchObject({ status: 403 });
    });
  });
});


/** Admission with the real effective-access views instead of a faked resolver. */
describePg('PostgreSQL container admission needs current coverage', () => {
  function coveredService(database: Kysely<NyabaseDatabase>): ContainerControlService {
    const transactions = new PgTransactionManager(database);
    const intents = new IntentRepository(database, noopWake());
    return makeContainerControlService(
      database,
      transactions,
      new ContainerControlRepository(database),
      new AccessResolverService(database, transactions),
      intents,
      {} as never,
      { append: vi.fn().mockResolvedValue(undefined) } as never,
      new IpPoolsRepository(database),
      { get: vi.fn().mockReturnValue(null) } as never,
      new ContainerSshConvergenceService(database, intents),
      {} as never,
      new GpuClaimsRepository(database),
    );
  }

  it('denies create without a grant or after the merged coverage expired, and admits it again', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const fixture = await seedFixture(database);
      const service = coveredService(database);
      const owner = testActor(fixture.userId);

      await expectCode(
        service.create(owner, request(fixture, 'no-grant')),
        FailureCode.PermissionDenied,
      );
      await grantServer(database, { user: fixture.userId }, fixture.serverId, { expiresAt: days(-1) });
      await expectCode(
        service.create(owner, request(fixture, 'expired')),
        FailureCode.PermissionDenied,
      );
      expect(await database.selectFrom('control.containers').select('id').execute()).toEqual([]);

      await database.updateTable('iam.server_grants')
        .set({ expires_at: days(3) })
        .where('user_id', '=', fixture.userId)
        .execute();
      await expect(service.create(owner, request(fixture, 'covered'))).resolves.toMatchObject({
        resourceType: 'container',
      });
    });
  });

  it('enforces the merged ceiling: the larger of a direct and a group grant applies', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const fixture = await seedFixture(database);
      const service = coveredService(database);
      const owner = testActor(fixture.userId);
      const group = randomUUID();
      await database.insertInto('iam.groups').values({
        id: group, name: `merge-${group.slice(0, 8)}`, description: null, revision: 1,
      }).execute();
      await database.insertInto('iam.group_members')
        .values({ id: randomUUID(), group_id: group, user_id: fixture.userId }).execute();
      await grantServer(database, { user: fixture.userId }, fixture.serverId, {
        cpuCores: 1, memBytes: 1_000,
      });
      await grantServer(database, { group }, fixture.serverId, { cpuCores: 4, memBytes: 400 });

      await expectCode(
        service.create(owner, request(fixture, 'mem-too-big', { memBytes: 2_000, powerIntent: ContainerPowerIntent.Running })),
        FailureCode.MemoryGrantExceeded,
      );
      // Memory comes from the larger (direct) grant and is a total across the user's running containers.
      const running = { powerIntent: ContainerPowerIntent.Running };
      await expect(service.create(owner, request(fixture, 'first', { memBytes: 600, ...running }))).resolves.toBeDefined();
      await expectCode(
        service.create(owner, request(fixture, 'second', { memBytes: 500, ...running })),
        FailureCode.MemoryGrantExceeded,
      );
      await expect(service.create(owner, request(fixture, 'third', { memBytes: 400, ...running }))).resolves.toBeDefined();
    });
  });

  it('denies owner start and restart without coverage, still lets an operator, and allows it after coverage returns', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const fixture = await seedFixture(database);
      const service = coveredService(database);
      const owner = testActor(fixture.userId);
      const operatorId = await seedUser(database, undefined, undefined, Role.Operator);
      const operator = testActor(operatorId, Role.Operator);
      await grantServer(database, { user: fixture.userId }, fixture.serverId);
      const { resourceId: containerId } = await service.create(owner, request(fixture, 'lapse'));

      await database.deleteFrom('iam.server_grants').where('user_id', '=', fixture.userId).execute();
      await expect(service.action(owner, containerId, 'start')).rejects.toMatchObject({ status: 403 });
      await expect(service.action(owner, containerId, 'restart')).rejects.toMatchObject({ status: 403 });
      await expect(service.action(operator, containerId, 'start', 'all')).resolves.toBeDefined();
      await database.updateTable('control.containers')
        .set({ power_intent: 'stopped' })
        .where('id', '=', containerId)
        .execute();

      await grantServer(database, { user: fixture.userId }, fixture.serverId);
      await expect(service.action(owner, containerId, 'start')).resolves.toBeDefined();
    });
  });

  it('denies start while a mounted volume\'s storage pool is no longer covered', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const fixture = await seedFixture(database);
      const service = coveredService(database);
      const owner = testActor(fixture.userId);
      await grantServer(database, { user: fixture.userId }, fixture.serverId);
      await grantPool(database, { user: fixture.userId }, fixture.poolId, days(-1));
      const { resourceId: containerId } = await service.create(owner, request(fixture, 'mounted'));
      const volumeId = await seedVolume(database, {
        ownerId: fixture.userId, poolId: fixture.poolId, serverId: fixture.serverId,
      });
      await seedAttachment(database, containerId, volumeId);

      await expect(service.action(owner, containerId, 'start')).rejects.toMatchObject({
        response: expect.anything(),
        status: 403,
      });
      // Stopping is always allowed with server coverage; starting is not.
      await database.updateTable('iam.storage_pool_grants')
        .set({ expires_at: null })
        .where('user_id', '=', fixture.userId)
        .execute();
      await expect(service.action(owner, containerId, 'start')).resolves.toBeDefined();
    });
  });
});

function containerService(
  database: Kysely<NyabaseDatabase>,
  options: GrantOptions,
  accessState?: {
    grant: ReturnType<typeof grant>;
    imageAvailable: boolean;
  },
  gpuClaims?: GpuClaimsRepository,
): {
  service: ContainerControlService;
  access: {
    resolveContainerCreateAccessInTransaction: ReturnType<typeof vi.fn>;
  };
} {
  const access = {
    resolveContainerCreateAccessInTransaction: vi.fn().mockResolvedValue(
      accessState ?? {
        grant: grant(options),
        imageAvailable: true,
      },
    ),
  };
  const intents = new IntentRepository(database, noopWake());
  const service = makeContainerControlService(
    database,
    new PgTransactionManager(database),
    new ContainerControlRepository(database),
    access as never,
    intents,
    {} as never,
    { append: vi.fn().mockResolvedValue(undefined) } as never,
    new IpPoolsRepository(database),
    { get: vi.fn().mockReturnValue(null) } as never,
    new ContainerSshConvergenceService(database, intents),
    {} as never,
    gpuClaims ?? new GpuClaimsRepository(database),
  );
  return { service, access };
}

function gpuHarness(
  database: Kysely<NyabaseDatabase>,
  options: GrantOptions,
) {
  return containerService(database, options, undefined, new GpuClaimsRepository(database));
}

async function enableGpu(
  database: Kysely<NyabaseDatabase>,
  fixture: Fixture,
): Promise<void> {
  await database.updateTable('infra.servers')
    .set({ gpu_enabled: true, gpu_enabled_by: fixture.userId })
    .where('id', '=', fixture.serverId)
    .execute();
}

function grant(options: GrantOptions): {
  cpuCores: number;
  memBytes: number;
  diskBytes: number | null;
  gpuPciAddresses: string[];
} {
  return {
    cpuCores: 10,
    memBytes: 10_000,
    diskBytes: options.diskBytes,
    gpuPciAddresses: options.gpuPciAddresses ?? [],
  };
}

function request(
  fixture: Fixture,
  name: string,
  overrides: Partial<CreateContainerRequest> = {},
): CreateContainerRequest {
  return {
    serverId: fixture.serverId,
    imageId: fixture.imageId,
    name,
    rootSizeBytes: 100,
    memBytes: 500,
    powerIntent: ContainerPowerIntent.Stopped,
    ...overrides,
  };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    response: { code },
  });
}

async function seedFixture(
  database: Kysely<NyabaseDatabase>,
  options: SeedOptions = {},
): Promise<Fixture> {
  const userId = cryptoId();
  const serverId = cryptoId();
  const poolId = cryptoId();
  const imageId = cryptoId();
  const fingerprint = IMAGE_FINGERPRINT;
  const cidr = options.cidr ?? '10.40.0.0/24';
  const gateway = options.gateway ?? '10.40.0.1';
  const reservedIps = options.reservedIps ?? [gateway];

  await database.insertInto('iam.users').values({
    id: userId,
    numeric_id: 1001,
    username: `container-${userId.slice(0, 8)}`,
    password_hash: 'unused',
    display_name: 'Container Test User',
    status: UserStatus.Active,
    auth_version: 1,
  }).execute();
  await database.insertInto('infra.servers').values({
    id: serverId,
    name: 'Container Test Server',
    slug: `container-${serverId.slice(0, 8)}`,
    incus_version: null,
    api_extensions: [],
    system_pool_id: null,
    storage_overcommit_ratio: options.overcommitRatio ?? 1,
    parent_interface: 'eth0',
    dns_servers: [gateway],
    status: options.serverStatus ?? ServerStatus.Online,
    last_seen_at: new Date(),
    last_error: null,
    revision: 1,
    node_metrics_status: 'unknown',
    node_metrics_last_success_at: null,
    node_metrics_outage_since: null,
    node_metrics_last_error: null,
    preflight_status: options.preflightStatus ?? 'passed',
    preflight_checked_at: new Date(),
    preflight_report: null,
  }).execute();
  const ipPoolId = cryptoId();
  await database.insertInto('infra.ip_pools').values({
    id: ipPoolId,
    name: `pool-${ipPoolId.slice(0, 8)}`,
    cidr,
    allocation_cidr: cidr,
    gateway,
    reserved_ips: JSON.stringify(reservedIps),
    revision: 1,
  }).execute();
  await database.insertInto('infra.ip_pool_servers').values({
    pool_id: ipPoolId,
    server_id: serverId,
  }).execute();
  await database.insertInto('infra.storage_pools').values({
    id: poolId,
    server_id: serverId,
    incus_name: `pool-${poolId.slice(0, 8)}`,
    driver: 'dir',
    resize_family: 'quota_online',
    root_disk_capable: true,
    shareable: false,
    block_filesystem: null,
    shared_backend_id: null,
    total_bytes: options.poolTotalBytes ?? 10_000,
    used_bytes: 0,
    quota_effective: true,
    display_name: null,
    registered: true,
    last_observed_at: new Date(),
    revision: 1,
  }).execute();
  await database.updateTable('infra.servers')
    .set({ system_pool_id: poolId })
    .where('id', '=', serverId)
    .execute();
  await database.insertInto('infra.images').values({
    id: imageId,
    alias: `test-${imageId.slice(0, 8)}`,
    fingerprint,
    description: null,
    login_user: 'root',
    min_root_size_bytes: options.minimumRootSizeBytes ?? 100,
    network_managed_externally: true,
    is_active: true,
    deleting: false,
    cleanup_generation: 0,
    revision: 1,
  }).execute();
  await database.insertInto('infra.image_server_assignments').values({
    id: cryptoId(),
    image_id: imageId,
    server_id: serverId,
    revision: 1,
    observed_fingerprint: fingerprint,
    managed_fingerprint: fingerprint,
    lifecycle_phase: 'active',
    needs_attention: false,
    failure_code: null,
    failure_reason: null,
    last_observed_at: new Date(),
  }).execute();
  return { userId, serverId, poolId, imageId, fingerprint };
}

async function seedSharedVolume(
  database: Kysely<NyabaseDatabase>,
  fixture: Fixture,
  sizeBytes: number,
): Promise<void> {
  const backendId = cryptoId();
  const poolId = cryptoId();
  const volumeId = cryptoId();
  await database.insertInto('infra.shared_backends').values({
    id: backendId,
    name: `shared-${backendId.slice(0, 8)}`,
    display_name: null,
    identity_key: `identity-${backendId}`,
    ceph_fsid: '00000000-0000-0000-0000-000000000001',
    total_bytes: sizeBytes + 1,
    used_bytes: 0,
    overcommit_ratio: 1,
    revision: 1,
  }).execute();
  await database.insertInto('infra.storage_pools').values({
    id: poolId,
    server_id: fixture.serverId,
    incus_name: `shared-${poolId.slice(0, 8)}`,
    driver: 'cephfs',
    resize_family: 'quota_online',
    root_disk_capable: false,
    shareable: true,
    block_filesystem: null,
    shared_backend_id: backendId,
    total_bytes: sizeBytes + 1,
    used_bytes: 0,
    quota_effective: true,
    display_name: null,
    registered: true,
    last_observed_at: new Date(),
    revision: 1,
  }).execute();
  await database.insertInto('control.volumes').values({
    id: volumeId,
    owner_id: fixture.userId,
    pool_id: null,
    server_id: null,
    shared_backend_id: backendId,
    name: `shared-volume-${volumeId.slice(0, 8)}`,
    incus_name: `nyv-${volumeId.replaceAll('-', '')}`,
    size_bytes: sizeBytes,
    used_bytes: null,
    revision: 1,
    observed_revision: null,
    lifecycle_phase: 'active',
    needs_attention: false,
    failure_code: null,
  }).execute();
}

function cryptoId(): string {
  return randomUUID();
}

describePg('PostgreSQL running-memory and GPU admission', () => {
  const RUNNING = { powerIntent: ContainerPowerIntent.Running };
  const GPU = '00000000:01:00.0';

  function quotaService(database: Kysely<NyabaseDatabase>): ContainerControlService {
    const transactions = new PgTransactionManager(database);
    const intents = new IntentRepository(database, noopWake());
    return makeContainerControlService(
      database,
      transactions,
      new ContainerControlRepository(database),
      new AccessResolverService(database, transactions),
      intents,
      {} as never,
      { append: vi.fn().mockResolvedValue(undefined) } as never,
      new IpPoolsRepository(database),
      { get: vi.fn().mockReturnValue(null) } as never,
      new ContainerSshConvergenceService(database, intents),
      {} as never,
      new GpuClaimsRepository(database),
    );
  }

  async function seed(database: Kysely<NyabaseDatabase>, memBytes: number | null, gpu: string[] = []) {
    const fixture = await seedFixture(database);
    await grantServer(database, { user: fixture.userId }, fixture.serverId, { memBytes, gpu });
    return { fixture, service: quotaService(database), owner: testActor(fixture.userId) };
  }

  async function setPower(database: Kysely<NyabaseDatabase>, id: string, power: 'running' | 'stopped') {
    await database.updateTable('control.containers').set({ power_intent: power }).where('id', '=', id).execute();
  }

  it('counts only running containers on start', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { fixture, service, owner } = await seed(database, 1_000);
      const a = await service.create(owner, request(fixture, 'a', { memBytes: 600, ...RUNNING }));
      const b = await service.create(owner, request(fixture, 'b', { memBytes: 600 }));
      await expectCode(service.action(owner, b.resourceId, 'start'), FailureCode.MemoryGrantExceeded);
      await setPower(database, a.resourceId, 'stopped');
      await expect(service.action(owner, b.resourceId, 'start')).resolves.toBeDefined();
    });
  });

  it('counts failed containers that intend to run, not deleting ones', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { fixture, service, owner } = await seed(database, 1_000);
      const a = await service.create(owner, request(fixture, 'a', { memBytes: 600, ...RUNNING }));
      const b = await service.create(owner, request(fixture, 'b', { memBytes: 600 }));
      await database.updateTable('control.containers').set({ lifecycle_phase: 'failed', failure_code: 'INSTANCE_CREATE_FAILED', failure_reason: 'boom' })
        .where('id', '=', a.resourceId).execute();
      // An intent retry could bring the failed container back, so it still counts.
      await expectCode(service.action(owner, b.resourceId, 'start'), FailureCode.MemoryGrantExceeded);
      await database.updateTable('control.containers').set({ lifecycle_phase: 'deleting' })
        .where('id', '=', a.resourceId).execute();
      await expect(service.action(owner, b.resourceId, 'start')).resolves.toBeDefined();
    });
  });

  it('gives an operator the owner rules on their own container; scope=all is the override', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { fixture, service } = await seed(database, 1_000);
      await database.updateTable('iam.users').set({ role: Role.Operator })
        .where('id', '=', fixture.userId).execute();
      const operator = testActor(fixture.userId, Role.Operator);
      const created = await service.create(operator, request(fixture, 'op-own', { memBytes: 5_000 }));
      await expectCode(service.action(operator, created.resourceId, 'start'), FailureCode.MemoryGrantExceeded);
      await expect(service.action(operator, created.resourceId, 'start', 'all')).resolves.toBeDefined();
    });
  });

  it('checks create only when it starts running', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { fixture, service, owner } = await seed(database, 1_000);
      await expect(service.create(owner, request(fixture, 'stopped', { memBytes: 5_000 }))).resolves.toBeDefined();
      await expectCode(
        service.create(owner, request(fixture, 'running', { memBytes: 5_000, ...RUNNING })),
        FailureCode.MemoryGrantExceeded,
      );
    });
  });

  it('checks limit increases only on running containers', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { fixture, service, owner } = await seed(database, 1_000);
      const stopped = await service.create(owner, request(fixture, 'stopped', { memBytes: 500 }));
      const running = await service.create(owner, request(fixture, 'running', { memBytes: 500, ...RUNNING }));
      await expect(service.updateLimits(owner, stopped.resourceId, { memBytes: 5_000 })).resolves.toBeDefined();
      await expectCode(
        service.updateLimits(owner, running.resourceId, { memBytes: 1_500 }),
        FailureCode.MemoryGrantExceeded,
      );
      await expect(service.updateLimits(owner, running.resourceId, { memBytes: 1_000 })).resolves.toBeDefined();
      await expect(service.updateLimits(owner, running.resourceId, { memBytes: 100 })).resolves.toBeDefined();
    });
  });

  it('lets restart and admin start through after the grant shrank', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { fixture, service, owner } = await seed(database, 1_000);
      const operatorId = await seedUser(database, undefined, undefined, Role.Operator);
      const operator = testActor(operatorId, Role.Operator);
      const running = await service.create(owner, request(fixture, 'running', { memBytes: 800, ...RUNNING }));
      const stopped = await service.create(owner, request(fixture, 'stopped', { memBytes: 800 }));
      await database.updateTable('iam.server_grants').set({ mem_bytes: 100 })
        .where('user_id', '=', fixture.userId).execute();
      await database.updateTable('control.container_ssh_routes')
        .set({ instance_status: 'Running' }).where('container_id', '=', running.resourceId).execute();
      await expect(service.action(owner, running.resourceId, 'restart')).resolves.toBeDefined();
      await expectCode(service.action(owner, stopped.resourceId, 'start'), FailureCode.MemoryGrantExceeded);
      await expect(service.action(operator, stopped.resourceId, 'start', 'all')).resolves.toBeDefined();
    });
  });

  it('admits exactly one of two concurrent starts that only fit alone', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { fixture, service, owner } = await seed(database, 1_000);
      const a = await service.create(owner, request(fixture, 'a', { memBytes: 600 }));
      const b = await service.create(owner, request(fixture, 'b', { memBytes: 600 }));
      const results = await Promise.allSettled([
        service.action(owner, a.resourceId, 'start'),
        service.action(owner, b.resourceId, 'start'),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    });
  });

  it('rejects start while a claimed GPU is outside the grant and allows it once re-granted', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { fixture, service, owner } = await seed(database, null);
      const created = await service.create(owner, request(fixture, 'gpu'));
      await database.insertInto('control.container_gpu_claims').values({
        container_id: created.resourceId, server_id: fixture.serverId, pci_address: GPU,
      }).execute();
      await expectCode(service.action(owner, created.resourceId, 'start'), FailureCode.GpuNotGranted);
      await database.updateTable('iam.server_grants').set({ gpu_pci_addresses: [GPU] })
        .where('user_id', '=', fixture.userId).execute();
      await expect(service.action(owner, created.resourceId, 'start')).resolves.toBeDefined();
    });
  });
});
