import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import {
  ContainerPowerIntent,
  FailureCode,
  GpuGrantMode,
  ServerStatus,
  UserStatus,
  type CreateContainerRequest,
} from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';
import { AccessCacheEpochService } from '../access/access-cache-epoch.service.js';
import { AccessResolverService } from '../access/access-resolver.service.js';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { withPostgresTestDatabase } from '../persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { IntentRepository } from '../runtime/intent.repository.js';
import { ContainerReconciler } from '../runtime/container-reconciler.service.js';
import { ContainerActionPolicyService } from './container-action-policy.service.js';
import { ContainerControlRepository } from './container-control.repository.js';
import { ContainerControlService } from './container-control.service.js';
import { ImagesService } from '../images/images.service.js';
import { IpPoolsRepository } from '../ip-pools/ip-pools.repository.js';
import { ContainerSshConvergenceService } from '../ssh/container-ssh-convergence.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;
const IMAGE_FINGERPRINT = 'a'.repeat(64);
const GPU_PCI_ADDRESS = '00000000:01:00.0';
const SHORT_GPU_PCI_ADDRESS = '0000:01:00.0';

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
  gpuRuntimeAvailable?: boolean;
  poolTotalBytes?: number;
  overcommitRatio?: number;
  minimumRootSizeBytes?: number;
}

interface GrantOptions {
  diskBytes: number | null;
  gpuMode?: GpuGrantMode;
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
        service.service.createForUser(fixture.userId, request(fixture, 'below-min-root', {
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
        service.service.createForUser(fixture.userId, request(fixture, 'inactive-assignment')),
        FailureCode.ImageAssignmentFingerprintMismatch,
      );
      await database.updateTable('infra.image_server_assignments')
        .set({ lifecycle_phase: 'active', observed_fingerprint: 'b'.repeat(64) })
        .where('image_id', '=', fixture.imageId)
        .where('server_id', '=', fixture.serverId)
        .execute();

      await expectCode(
        service.service.createForUser(fixture.userId, request(fixture, 'fingerprint-mismatch')),
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
        service.service.createForUser(fixture.userId, request(fixture, 'preflight-failed')),
        FailureCode.PreflightFailed,
      );

      await database.updateTable('infra.servers')
        .set({ preflight_status: 'passed', system_pool_id: null })
        .where('id', '=', fixture.serverId)
        .execute();
      await expectCode(
        service.service.createForUser(fixture.userId, request(fixture, 'system-pool-missing')),
        FailureCode.StoragePoolExhausted,
      );
      expect(await database.selectFrom('control.containers').select('id').execute()).toEqual([]);
    });
  });

  it('resolves the server and PCI grant from PostgreSQL before admitting a GPU create', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const fixture = await seedFixture(database);
      await seedServerGrant(database, fixture, {
        diskBytes: 10_000,
        gpuMode: GpuGrantMode.None,
        gpuPciAddresses: [],
      });
      const service = databaseAccessContainerService(database);

      await expectCode(
        service.createForUser(fixture.userId, request(fixture, 'database-gpu-denied', {
          gpuPciAddresses: [GPU_PCI_ADDRESS],
        })),
        FailureCode.PermissionDenied,
      );

      await database.updateTable('iam.server_grants')
        .set({
          gpu_mode: GpuGrantMode.Pci,
          gpu_pci_addresses: [GPU_PCI_ADDRESS],
        })
        .where('user_id', '=', fixture.userId)
        .where('server_id', '=', fixture.serverId)
        .execute();
      await expect(service.createForUser(fixture.userId, request(fixture, 'database-gpu-accepted', {
        gpuPciAddresses: [GPU_PCI_ADDRESS],
      }))).resolves.toMatchObject({ status: 'pending' });
    });
  });

  it('releases GPU admission claims when a container becomes failed or deleting', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const fixture = await seedFixture(database);
      const service = containerService(database, { diskBytes: 10_000 });

      const failed = await service.service.createForUser(
        fixture.userId,
        request(fixture, 'failed-gpu', { gpuPciAddresses: [GPU_PCI_ADDRESS] }),
      );
      await database.updateTable('control.containers')
        .set({ lifecycle_phase: 'failed', failure_code: 'TEST_TERMINAL' })
        .where('id', '=', failed.resourceId)
        .execute();

      const deleting = await service.service.createForUser(
        fixture.userId,
        request(fixture, 'deleting-gpu', { gpuPciAddresses: [GPU_PCI_ADDRESS] }),
      );
      await database.updateTable('control.containers')
        .set({ lifecycle_phase: 'deleting' })
        .where('id', '=', deleting.resourceId)
        .execute();

      await expect(service.service.createForUser(
        fixture.userId,
        request(fixture, 'reused-gpu', { gpuPciAddresses: [GPU_PCI_ADDRESS] }),
      )).resolves.toMatchObject({ status: 'pending' });
      expect(await database.selectFrom('control.containers')
        .select('id')
        .execute()).toHaveLength(3);
    });
  });

  it('does not grow settled container intents across repeated full scans', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const fixture = await seedFixture(database);
      const service = containerService(database, { diskBytes: 10_000 });
      const created = await service.service.createForUser(
        fixture.userId,
        request(fixture, 'scan-idempotent'),
      );
      const intents = new IntentRepository(database);
      await intents.settleForObservedGeneration(
        'container',
        created.resourceId,
        1,
        { outcome: 'succeeded' },
      );
      const reconciler = new ContainerReconciler(database, intents);
      const client = {
        listInstances: vi.fn().mockResolvedValue({ metadata: [] }),
      };

      await reconciler.scan(fixture.serverId, client as never, new AbortController().signal);
      await reconciler.scan(fixture.serverId, client as never, new AbortController().signal);

      expect(await database.selectFrom('control.intents')
        .select('id')
        .where('resource_id', '=', created.resourceId)
        .execute()).toHaveLength(1);
    });
  });

  it('enforces GPU grants, server runtime readiness, routed IP claims, and drain-safe allocation', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const fixture = await seedFixture(database, {
        cidr: '10.40.0.0/30',
        gateway: '10.40.0.1',
        reservedIps: ['10.40.0.1'],
        gpuRuntimeAvailable: true,
      });
      const access = {
        grant: grant({ diskBytes: 10_000, gpuMode: GpuGrantMode.None }),
        imageAvailable: true,
      };
      const service = containerService(database, { diskBytes: 10_000 }, access);

      await expectCode(
        service.service.createForUser(fixture.userId, request(fixture, 'gpu-denied', {
          gpuPciAddresses: [GPU_PCI_ADDRESS],
        })),
        FailureCode.PermissionDenied,
      );

      access.grant.gpu = {
        mode: GpuGrantMode.Pci,
        pciAddresses: [GPU_PCI_ADDRESS],
      };
      const accepted = await service.service.createForUser(fixture.userId, request(fixture, 'first-address', {
        gpuPciAddresses: [SHORT_GPU_PCI_ADDRESS],
      }));
      expect(accepted.status).toBe('pending');
      expect(await database.selectFrom('control.container_gpu_claims')
        .select('gpu_pci_address')
        .execute()).toEqual([{ gpu_pci_address: GPU_PCI_ADDRESS }]);
      await expect(database.insertInto('control.container_gpu_claims').values({
        id: randomUUID(),
        container_id: accepted.resourceId,
        server_id: fixture.serverId,
        gpu_pci_address: SHORT_GPU_PCI_ADDRESS,
      }).execute()).rejects.toMatchObject({ code: '23514' });

      await expectCode(
        service.service.createForUser(fixture.userId, request(fixture, 'address-exhausted')),
        FailureCode.NetworkAddressExhausted,
      );
      expect(await database.selectFrom('control.container_network_claims')
        .select(['address', 'state'])
        .execute()).toMatchObject([{ address: '10.40.0.2', state: 'active' }]);
    });

    await withPostgresTestDatabase(async ({ database }) => {
      const fixture = await seedFixture(database, { gpuRuntimeAvailable: false });
      const service = containerService(database, {
        diskBytes: 10_000,
        gpuMode: GpuGrantMode.All,
      });
      await expectCode(
        service.service.createForUser(fixture.userId, request(fixture, 'runtime-unavailable', {
          gpuPciAddresses: [GPU_PCI_ADDRESS],
        })),
        FailureCode.GpuRuntimeUnavailable,
      );
    });
  });

  it('enforces UNIQUE GPU claims and admin ownerId', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const fixture = await seedFixture(database);
      const service = containerService(database, { diskBytes: 10_000, gpuMode: GpuGrantMode.All });
      await service.service.createForUser(fixture.userId, request(fixture, 'gpu-first', {
        gpuPciAddresses: [GPU_PCI_ADDRESS],
      }));
      await expectCode(
        service.service.createForUser(fixture.userId, request(fixture, 'gpu-second', {
          gpuPciAddresses: [GPU_PCI_ADDRESS],
        })),
        FailureCode.GpuAlreadyClaimed,
      );
      const second = await service.service.createForUser(fixture.userId, request(fixture, 'gpu-empty'));
      await expect(database.insertInto('control.container_gpu_claims').values({
        id: randomUUID(),
        container_id: second.resourceId,
        server_id: fixture.serverId,
        gpu_pci_address: GPU_PCI_ADDRESS,
      }).execute()).rejects.toMatchObject({ code: '23505' });

      const first = await database.selectFrom('control.containers')
        .select('id')
        .where('name', '=', 'gpu-first')
        .executeTakeFirstOrThrow();
      await database.updateTable('control.containers')
        .set({ lifecycle_phase: 'failed', failure_code: 'TEST' })
        .where('id', '=', first.id)
        .execute();
      expect(await database.selectFrom('control.container_gpu_claims')
        .select('gpu_pci_address')
        .where('gpu_pci_address', '=', GPU_PCI_ADDRESS)
        .execute()).toEqual([]);
    });

    await withPostgresTestDatabase(async ({ database }) => {
      const fixture = await seedFixture(database);
      const service = containerService(database, { diskBytes: 10_000 });
      await expectCode(
        service.service.createForAdmin(fixture.userId, request(fixture, 'admin-no-owner')),
        FailureCode.InvalidInput,
      );
      await expectCode(
        service.service.createForUser(fixture.userId, request(fixture, 'user-owner', {
          ownerId: fixture.userId,
        })),
        FailureCode.InvalidInput,
      );
      const ownerId = cryptoId();
      await database.insertInto('iam.users').values({
        id: ownerId,
        numeric_id: 1002,
        username: `owner-${ownerId.slice(0, 8)}`,
        password_hash: 'unused',
        display_name: 'Owner',
        status: UserStatus.Active,
        auth_version: 1,
        authz_version: 1,
      }).execute();
      const accepted = await service.service.createForAdmin(fixture.userId, request(fixture, 'admin-owned', {
        ownerId,
      }));
      const row = await database.selectFrom('control.containers')
        .select(['owner_id', 'created_by'])
        .where('id', '=', accepted.resourceId)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ owner_id: ownerId, created_by: fixture.userId });

      const disabledId = cryptoId();
      await database.insertInto('iam.users').values({
        id: disabledId,
        numeric_id: 1003,
        username: `disabled-${disabledId.slice(0, 8)}`,
        password_hash: 'unused',
        display_name: 'Disabled',
        status: UserStatus.Disabled,
        auth_version: 1,
        authz_version: 1,
      }).execute();
      await expect(service.service.createForAdmin(fixture.userId, request(fixture, 'disabled-owner', {
        ownerId: disabledId,
      }))).rejects.toMatchObject({ status: 404 });
    });
  });

  it('enforces independent server quota and storage-pool overcommit capacity', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const fixture = await seedFixture(database, {
        poolTotalBytes: 10_000,
        minimumRootSizeBytes: 1,
      });
      const service = containerService(database, { diskBytes: 150 });
      await service.service.createForUser(fixture.userId, request(fixture, 'quota-first', {
        rootSizeBytes: 100,
      }));
      await expectCode(
        service.service.createForUser(fixture.userId, request(fixture, 'quota-second', {
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
      await service.service.createForUser(fixture.userId, request(fixture, 'pool-first', {
        rootSizeBytes: 100,
      }));
      await expectCode(
        service.service.createForUser(fixture.userId, request(fixture, 'pool-second', {
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
        service.service.createForUser(fixture.userId, request(fixture, 'concurrent-a', { rootSizeBytes: 100 })),
        service.service.createForUser(fixture.userId, request(fixture, 'concurrent-b', { rootSizeBytes: 100 })),
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
      const containerState = containerService(database, { diskBytes: 10_000 });
      const imageIntents = {
        ensurePending: vi.fn(async (input: {
          resourceId: string;
          serverId: string;
          targetGeneration: number;
          kind: string;
        }) => ({
          id: randomUUID(),
          kind: input.kind,
          resourceType: 'image_assignment' as const,
          resourceId: input.resourceId,
          serverId: input.serverId,
          requestedBy: fixture.userId,
          request: null,
          targetGeneration: input.targetGeneration,
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
        { assertActorCapabilitiesInTransaction: vi.fn() } as never,
        { append: vi.fn().mockResolvedValue(undefined) } as never,
        imageIntents as never,
        { wake: vi.fn() } as never,
      );

      const [deleteResult, createResult] = await Promise.all([
        images.delete(fixture.userId, fixture.imageId).then(
          (value) => ({ status: 'fulfilled' as const, value }),
          (reason) => ({ status: 'rejected' as const, reason }),
        ),
        containerState.service.createForUser(fixture.userId, request(fixture, 'image-delete-race')).then(
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

      const first = await serviceState.service.createForUser(
        fixture.userId,
        request(fixture, 'pending-larger', { rootSizeBytes: 100 }),
      );
      await database.updateTable('control.containers')
        .set({ root_size_pending_bytes: 300 })
        .where('id', '=', first.resourceId)
        .execute();

      const second = await serviceState.service.createForUser(
        fixture.userId,
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

      const third = await serviceState.service.createForUser(
        fixture.userId,
        request(fixture, 'max-and-shared-excluded', { rootSizeBytes: 100 }),
      );
      expect(third.status).toBe('pending');
      expect(await database.selectFrom('control.containers').select('id').execute()).toHaveLength(3);
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
    assertActorCapabilitiesInTransaction: vi.fn(),
  };
  const intents = new IntentRepository(database);
  const wake = { wake: vi.fn() } as never;
  const service = new ContainerControlService(
    database,
    new PgTransactionManager(database),
    new ContainerControlRepository(database),
    access as never,
    intents,
    wake,
    {} as never,
    { append: vi.fn().mockResolvedValue(undefined) } as never,
    new ContainerActionPolicyService(),
    new IpPoolsRepository(database),
    { get: vi.fn().mockReturnValue(null) } as never,
    new ContainerSshConvergenceService(database, intents, wake),
  );
  return { service, access };
}

function databaseAccessContainerService(database: Kysely<NyabaseDatabase>): ContainerControlService {
  const intents = new IntentRepository(database);
  const wake = { wake: vi.fn() } as never;
  return new ContainerControlService(
    database,
    new PgTransactionManager(database),
    new ContainerControlRepository(database),
    new AccessResolverService(
      database,
      new PgTransactionManager(database),
      new AccessCacheEpochService(database),
    ),
    intents,
    wake,
    {} as never,
    { append: vi.fn().mockResolvedValue(undefined) } as never,
    new ContainerActionPolicyService(),
    new IpPoolsRepository(database),
    { get: vi.fn().mockReturnValue(null) } as never,
    new ContainerSshConvergenceService(database, intents, wake),
  );
}

function grant(options: GrantOptions): {
  accessPhase: 'live';
  cpuMillis: number;
  memBytes: number;
  diskBytes: number | null;
  gpu: { mode: GpuGrantMode; pciAddresses: string[] };
} {
  return {
    accessPhase: 'live',
    cpuMillis: 10_000,
    memBytes: 10_000,
    diskBytes: options.diskBytes,
    gpu: {
      mode: options.gpuMode ?? GpuGrantMode.All,
      pciAddresses: options.gpuPciAddresses ?? [],
    },
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
    cpuMillis: 500,
    memBytes: 500,
    gpuPciAddresses: [],
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
    authz_version: 1,
  }).execute();
  await database.insertInto('infra.servers').values({
    id: serverId,
    name: 'Container Test Server',
    slug: `container-${serverId.slice(0, 8)}`,
    api_endpoint: 'https://incus.example.test:8443',
    server_cert_fingerprint: null,
    incus_version: null,
    api_extensions: [],
    system_pool_id: null,
    storage_overcommit_ratio: options.overcommitRatio ?? 1,
    parent_interface: 'eth0',
    dns_servers: [gateway],
    gpu_runtime_available: options.gpuRuntimeAvailable ?? true,
    status: options.serverStatus ?? ServerStatus.Online,
    last_seen_at: new Date(),
    last_error: null,
    revision: 1,
    node_metrics_endpoint: null,
    node_metrics_server_cert_fingerprint: null,
    node_metrics_token_ciphertext: null,
    node_metrics_token_fingerprint: null,
    node_metrics_status: 'unconfigured',
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
    name: `Test Image ${imageId.slice(0, 8)}`,
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
    generation: 1,
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

async function seedServerGrant(
  database: Kysely<NyabaseDatabase>,
  fixture: Fixture,
  options: {
    diskBytes: number;
    gpuMode: GpuGrantMode;
    gpuPciAddresses: string[];
  },
): Promise<void> {
  await database.insertInto('iam.server_grants').values({
    id: cryptoId(),
    user_id: fixture.userId,
    group_id: null,
    server_id: fixture.serverId,
    cpu_millis: 10_000,
    mem_bytes: 10_000,
    disk_bytes: options.diskBytes,
    gpu_mode: options.gpuMode,
    gpu_pci_addresses: options.gpuPciAddresses,
    expires_at: null,
  }).execute();
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
    pool_id: poolId,
    server_id: null,
    shared_backend_id: backendId,
    name: `shared-volume-${volumeId.slice(0, 8)}`,
    incus_name: `nyv-${volumeId.replaceAll('-', '')}`,
    size_bytes: sizeBytes,
    used_bytes: null,
    generation: 1,
    observed_generation: null,
    lifecycle_phase: 'active',
    needs_attention: false,
    failure_code: null,
  }).execute();
}

function cryptoId(): string {
  return randomUUID();
}
