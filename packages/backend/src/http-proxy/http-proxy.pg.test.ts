import { randomUUID } from 'node:crypto';
import {
  ContainerPhase,
  ContainerPowerIntent,
  ContainerStatus,
  MAX_HTTP_PROXY_DOMAIN_POOLS,
  ServerStatus,
  UserStatus,
} from '@nyabase/common';
import type { Kysely } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import {
  withPostgresTestDatabase,
} from '../persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { HttpProxyService } from './http-proxy.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePg('HTTP proxy PostgreSQL authority', () => {
  it('rolls back binding and hostname ownership when required audit append fails', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const seed = await seedRuntime(database);
      await makeService(database).createDomainPool(seed.userId, {
        wildcardDomain: '*.apps.example.test',
        enabled: true,
        httpsEnabled: false,
      });
      const audit = { append: vi.fn().mockRejectedValue(new Error('audit unavailable')) };
      await expect(makeService(database, audit).createBinding(seed.userId, {
        hostname: 'atomic.apps.example.test',
        containerId: seed.containerId,
        targetPort: 8080,
      })).rejects.toThrow('audit unavailable');
      expect(await database.selectFrom('interaction.http_proxy_bindings')
        .select('id').execute()).toEqual([]);
      expect(await database.selectFrom('interaction.http_hostname_reservations')
        .select('hostname').execute()).toEqual([]);
    });
  });

  it('preserves CRUD DTOs and drains a deleted binding before hostname reuse', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const seed = await seedRuntime(database);
      const service = makeService(database);
      const pool = await service.createDomainPool(seed.userId, {
        wildcardDomain: '*.apps.example.test',
        enabled: true,
        httpsEnabled: false,
      });
      const binding = await service.createBinding(seed.userId, {
        hostname: 'demo.apps.example.test',
        containerId: seed.containerId,
        targetPort: 8080,
      });

      expect(binding).toMatchObject({
        mine: true,
        ownerId: seed.userId,
        ownerUsername: 'proxy-owner',
        domainPoolId: pool.id,
        domainPool: '*.apps.example.test',
        targetUrl: 'http://10.44.0.2:8080',
        containerId: seed.containerId,
        containerName: 'proxy-container',
        containerStatus: ContainerStatus.Running,
        targetPort: 8080,
        entryHttpsEnabled: false,
        status: 'warning',
        warningReasons: ['proxy_offline'],
      });

      const updated = await service.updateBinding(seed.userId, binding.id, {
        targetPort: 9090,
      });
      expect(updated.targetUrl).toBe('http://10.44.0.2:9090');
      expect(await service.listBindings(seed.userId, true)).toEqual([
        expect.objectContaining({ id: binding.id, status: 'ready' }),
      ]);

      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(new Date('2099-01-01T00:00:00Z'));
        await service.deleteBinding(seed.userId, binding.id);
      } finally {
        vi.useRealTimers();
      }
      expect(await database
        .selectFrom('interaction.http_proxy_bindings')
        .select('id')
        .execute()).toEqual([]);
      const reservation = await database
        .selectFrom('interaction.http_hostname_reservations')
        .select(['state', 'binding_id', 'reusable_at', 'release_generation'])
        .where('hostname', '=', binding.hostname)
        .executeTakeFirstOrThrow();
      expect(reservation).toMatchObject({
        state: 'releasing',
        binding_id: null,
        release_generation: '1',
      });
      const databaseNow = await database
        .selectNoFrom((expression) =>
          expression.fn<Date>('clock_timestamp').as('now'))
        .executeTakeFirstOrThrow();
      expect(reservation.reusable_at!.getTime()).toBeGreaterThan(
        databaseNow.now.getTime(),
      );
      await expect(service.createBinding(seed.userId, {
        hostname: binding.hostname,
        containerId: seed.containerId,
        targetPort: 8080,
      })).rejects.toMatchObject({
        status: 409,
        message: 'Hostname is already occupied or draining',
      });
    });
  });

  it('admits exactly one concurrent hostname and wildcard owner without leakage', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const seed = await seedRuntime(database);
      const service = makeService(database);
      const wildcardAttempts = await Promise.allSettled([
        service.createDomainPool(seed.userId, {
          wildcardDomain: '*.race.example.test',
          enabled: true,
          httpsEnabled: false,
        }),
        service.createDomainPool(seed.userId, {
          wildcardDomain: 'RACE.EXAMPLE.TEST.',
          enabled: true,
          httpsEnabled: false,
        }),
      ]);
      expect(wildcardAttempts.filter((result) =>
        result.status === 'fulfilled')).toHaveLength(1);
      const wildcardLoser = wildcardAttempts.find((result) =>
        result.status === 'rejected');
      expect(wildcardLoser).toMatchObject({
        reason: {
          status: 409,
          response: { code: 'HTTP_PROXY_DOMAIN_POOL_EXISTS' },
        },
      });

      const bindingAttempts = await Promise.allSettled([
        service.createBinding(seed.userId, {
          hostname: 'same.race.example.test',
          containerId: seed.containerId,
          targetPort: 80,
        }),
        service.createBinding(seed.userId, {
          hostname: 'SAME.RACE.EXAMPLE.TEST.',
          containerId: seed.containerId,
          targetPort: 81,
        }),
      ]);
      expect(bindingAttempts.filter((result) =>
        result.status === 'fulfilled')).toHaveLength(1);
      const bindingLoser = bindingAttempts.find((result) =>
        result.status === 'rejected');
      expect(bindingLoser).toMatchObject({
        reason: {
          status: 409,
          message: 'Hostname is already occupied or draining',
        },
      });
      expect(JSON.stringify(bindingLoser)).not.toContain(seed.userId);
    });
  });

  it('keeps snapshot generation and lease serial across service restarts and rollback', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const seed = await seedRuntime(database);
      const firstProcess = makeService(database);
      await firstProcess.createDomainPool(seed.userId, {
        wildcardDomain: '*.apps.example.test',
        enabled: true,
        httpsEnabled: false,
      });
      await firstProcess.createBinding(seed.userId, {
        hostname: 'snapshot.apps.example.test',
        containerId: seed.containerId,
        targetPort: 8080,
      });
      const first = await firstProcess.buildSnapshot();
      expect(first).toMatchObject({
        generation: 1,
        routes: [expect.objectContaining({
          hostname: 'snapshot.apps.example.test',
          targetIp: '10.44.0.2',
          runtimeId: 'runtime-a',
        })],
      });

      const restartedProcess = makeService(database);
      const [second, third] = await Promise.all([
        restartedProcess.buildSnapshot(),
        firstProcess.buildSnapshot(),
      ]);
      expect([second.generation, third.generation].sort((a, b) => a - b))
        .toEqual([2, 3]);

      const transactions = new PgTransactionManager(database);
      await expect(transactions.run(async (transaction) => {
        await transaction
          .updateTable('interaction.http_proxy_snapshot_state')
          .set({ generation: 999 })
          .where('singleton', '=', true)
          .execute();
        throw new Error('simulated process crash');
      })).rejects.toThrow('simulated process crash');

      const recovered = await makeService(database).buildSnapshot();
      expect(recovered.generation).toBe(4);
      const state = await database
        .selectFrom('interaction.http_proxy_snapshot_state')
        .select([
          'generation',
          'lease_issued_at',
          'lease_valid_until',
          'payload_sha256',
        ])
        .executeTakeFirstOrThrow();
      expect(state).toMatchObject({
        generation: '4',
        payload_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(state.lease_valid_until!.getTime())
        .toBeGreaterThan(state.lease_issued_at!.getTime());
    });
  });

  it('fences disabled owners/offline servers and drains container cascade deletes', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const seed = await seedRuntime(database);
      const service = makeService(database);
      await service.createDomainPool(seed.userId, {
        wildcardDomain: '*.apps.example.test',
        enabled: true,
        httpsEnabled: false,
      });
      const binding = await service.createBinding(seed.userId, {
        hostname: 'guard.apps.example.test',
        containerId: seed.containerId,
        targetPort: 8080,
      });

      await database.updateTable('iam.users')
        .set({ status: UserStatus.Disabled })
        .where('id', '=', seed.userId)
        .execute();
      expect(await service.listBindings(seed.userId, true)).toEqual([]);
      expect((await service.buildSnapshot()).routes).toEqual([]);

      await database.updateTable('iam.users')
        .set({ status: UserStatus.Active })
        .where('id', '=', seed.userId)
        .execute();
      await database.updateTable('infra.servers')
        .set({ status: ServerStatus.Offline })
        .where('id', '=', seed.serverId)
        .execute();
      expect((await service.buildSnapshot()).routes).toEqual([]);

      await database.transaction().execute(async (transaction) => {
        await transaction.updateTable('control.container_network_claims')
          .set({
            state: 'releasing',
            reusable_at: new Date(Date.now() + 60_000),
          })
          .where('container_id', '=', seed.containerId)
          .execute();
        await transaction.deleteFrom('control.containers')
          .where('id', '=', seed.containerId)
          .execute();
      });
      expect(await database
        .selectFrom('interaction.http_proxy_bindings')
        .select('id')
        .where('id', '=', binding.id)
        .executeTakeFirst()).toBeUndefined();
      expect(await database
        .selectFrom('interaction.http_hostname_reservations')
        .select(['state', 'binding_id', 'release_generation'])
        .where('hostname', '=', binding.hostname)
        .executeTakeFirstOrThrow()).toEqual({
        state: 'releasing',
        binding_id: null,
        release_generation: '1',
      });
    });
  });

  it('enforces the fixed domain-pool capacity under the mutation lock', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const seed = await seedRuntime(database);
      await database.insertInto('interaction.http_domain_pools')
        .values(Array.from({ length: MAX_HTTP_PROXY_DOMAIN_POOLS }, (_, index) => ({
          id: randomUUID(),
          wildcard_domain: `*.pool-${index}.example.test`,
          enabled: true,
          https_enabled: false,
          certificate_pem: null,
          encrypted_private_key_pem: null,
          certificate_fingerprint: null,
          certificate_not_after: null,
        })))
        .execute();
      await expect(makeService(database).createDomainPool(seed.userId, {
        wildcardDomain: '*.overflow.example.test',
        enabled: true,
        httpsEnabled: false,
      })).rejects.toMatchObject({
        status: 409,
        response: { code: 'HTTP_PROXY_DOMAIN_POOL_CAPACITY_REACHED' },
      });
    });
  });

  it('rechecks requester activity in the same admission transaction', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const seed = await seedRuntime(database);
      const service = makeService(database);
      await service.createDomainPool(seed.userId, {
        wildcardDomain: '*.apps.example.test',
        enabled: true,
        httpsEnabled: false,
      });
      await database.updateTable('iam.users')
        .set({ status: UserStatus.Disabled })
        .where('id', '=', seed.userId)
        .execute();
      await expect(service.createBinding(seed.userId, {
        hostname: 'revoked.apps.example.test',
        containerId: seed.containerId,
        targetPort: 80,
      })).rejects.toMatchObject({
        status: 403,
        message: 'Current user is no longer active',
      });
      expect(await database
        .selectFrom('interaction.http_proxy_bindings')
        .select('id')
        .execute()).toEqual([]);
      expect(await database
        .selectFrom('interaction.http_hostname_reservations')
        .select('hostname')
        .execute()).toEqual([]);
    });
  });

  it('preserves owner-only mutation and list boundaries', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const seed = await seedRuntime(database);
      const otherUserId = randomUUID();
      await database.insertInto('iam.users').values({
        id: otherUserId,
        numeric_id: 1002,
        username: 'proxy-other',
        password_hash: 'test-hash',
        display_name: 'Proxy Other',
        status: UserStatus.Active,
        auth_version: 0,
        authz_version: 0,
      }).execute();
      const service = makeService(database);
      await service.createDomainPool(seed.userId, {
        wildcardDomain: '*.apps.example.test',
        enabled: true,
        httpsEnabled: false,
      });
      const binding = await service.createBinding(seed.userId, {
        hostname: 'private.apps.example.test',
        containerId: seed.containerId,
        targetPort: 80,
      });
      expect(await service.listBindings(otherUserId, true)).toEqual([]);
      await expect(service.updateBinding(otherUserId, binding.id, {
        targetPort: 81,
      })).rejects.toMatchObject({
        status: 403,
        message: 'Only binding owner can edit it',
      });
      await expect(service.deleteBinding(otherUserId, binding.id))
        .rejects.toMatchObject({
          status: 403,
          message: 'Only binding owner can delete it',
        });
    });
  });

  it('prevents wildcard mutation or pool deletion while bindings exist', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const seed = await seedRuntime(database);
      const service = makeService(database);
      const pool = await service.createDomainPool(seed.userId, {
        wildcardDomain: '*.apps.example.test',
        enabled: true,
        httpsEnabled: false,
      });
      await service.createBinding(seed.userId, {
        hostname: 'bound.apps.example.test',
        containerId: seed.containerId,
        targetPort: 80,
      });
      await expect(service.updateDomainPool(seed.userId, pool.id, {
        wildcardDomain: '*.new.example.test',
      })).rejects.toMatchObject({
        status: 409,
        message: 'Domain pool wildcard cannot change while bindings exist',
      });
      await expect(service.deleteDomainPool(seed.userId, pool.id))
        .rejects.toMatchObject({
          status: 409,
          message: 'Domain pool still has bindings',
        });
    });
  });

  it('requires exactly one active network claim for the route address', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const seed = await seedRuntime(database);
      const service = makeService(database);
      await service.createDomainPool(seed.userId, {
        wildcardDomain: '*.apps.example.test',
        enabled: true,
        httpsEnabled: false,
      });
      await service.createBinding(seed.userId, {
        hostname: 'claim.apps.example.test',
        containerId: seed.containerId,
        targetPort: 80,
      });
      expect((await service.buildSnapshot()).routes).toHaveLength(1);
      await database.insertInto('control.container_network_claims').values({
        id: randomUUID(),
        container_id: null,
        owner_kind: 'runtime_cleanup',
        owner_id: 'orphan-runtime',
        server_id: seed.serverId,
        network_key: '10.44.0.0/28',
        address: '10.44.0.2',
        state: 'active',
        reusable_at: null,
        cleanup_payload_json: JSON.stringify({ runtimeId: 'orphan-runtime' }),
      }).execute();
      expect((await service.buildSnapshot()).routes).toEqual([]);
    });
  });

  it('keeps stale runtime warnings and snapshot exclusion behavior', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const seed = await seedRuntime(database);
      const service = makeService(database);
      await service.createDomainPool(seed.userId, {
        wildcardDomain: '*.apps.example.test',
        enabled: true,
        httpsEnabled: false,
      });
      await service.createBinding(seed.userId, {
        hostname: 'stale.apps.example.test',
        containerId: seed.containerId,
        targetPort: 80,
      });
      await database.updateTable('control.container_ssh_routes')
        .set({ observed_at: new Date(Date.now() - 121_000) })
        .where('container_id', '=', seed.containerId)
        .execute();
      expect(await service.listBindings(seed.userId, true)).toEqual([
        expect.objectContaining({
          status: 'warning',
          warningReasons: ['container_runtime_stale'],
        }),
      ]);
      expect((await service.buildSnapshot()).routes).toEqual([]);
    });
  });

  it('keeps disabled pool DTO and snapshot behavior unchanged', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const seed = await seedRuntime(database);
      const service = makeService(database);
      const pool = await service.createDomainPool(seed.userId, {
        wildcardDomain: '*.apps.example.test',
        enabled: true,
        httpsEnabled: false,
      });
      await service.createBinding(seed.userId, {
        hostname: 'disabled.apps.example.test',
        containerId: seed.containerId,
        targetPort: 80,
      });
      await service.updateDomainPool(seed.userId, pool.id, { enabled: false });
      expect(await service.listBindings(seed.userId, true)).toEqual([
        expect.objectContaining({
          status: 'disabled',
          warningReasons: ['domain_pool_disabled'],
        }),
      ]);
      expect((await service.buildSnapshot()).routes).toEqual([]);
    });
  });
});

function makeService(
  database: Kysely<NyabaseDatabase>,
  audit: { append: ReturnType<typeof vi.fn> } = {
    append: vi.fn().mockResolvedValue(undefined),
  },
): HttpProxyService {
  return new HttpProxyService(
    database,
    new PgTransactionManager(database),
    {
      get: vi.fn((key: string) =>
        key === 'ssh.keyEncryptionSecret' ? 'test-secret' : 'jwt-secret'),
    } as never,
    {
      assertActorCapabilitiesInTransaction: vi.fn().mockResolvedValue(new Set()),
    } as never,
    {
      isServerBlocked: vi.fn().mockReturnValue(false),
    } as never,
    audit as never,
  );
}

async function seedRuntime(database: Kysely<NyabaseDatabase>) {
  const userId = randomUUID();
  const serverId = randomUUID();
  const imageId = randomUUID();
  const containerId = randomUUID();
  await database.insertInto('iam.users').values({
    id: userId,
    numeric_id: 1001,
    username: 'proxy-owner',
    password_hash: 'test-hash',
    display_name: 'Proxy Owner',
    status: UserStatus.Active,
    auth_version: 0,
    authz_version: 0,
  }).execute();
  await database.insertInto('infra.servers').values({
    id: serverId,
    name: 'Proxy Node',
    slug: 'proxy-node',
    agent_token_hash: 'a'.repeat(64),
    host_fingerprint: 'host-a',
    agent_config_fingerprint: 'config-a',
    status: ServerStatus.Online,
    quarantine_code: null,
    quarantine_message: null,
    last_seen_at: new Date(),
    macvlan_cidr: '10.44.0.0/29',
    macvlan_gateway: '10.44.0.1',
    macvlan_reserved_ips: JSON.stringify([]),
    revision: 1,
  }).execute();
  const agentSessionId = randomUUID();
  const agentGatewayId = `gateway:test:${agentSessionId}`;
  const observedAt = new Date();
  await database.insertInto('workflow.agent_sessions').values({
    id: agentSessionId,
    server_id: serverId,
    generation: 1,
    session_token_hash: agentSessionId.replaceAll('-', '').padEnd(64, '0'),
    state: 'ready',
    host_fingerprint: 'host-a',
    config_fingerprint: 'config-a',
    gateway_id: agentGatewayId,
    console_public_url: 'wss://gateway.test/ws/console',
    lease_expires_at: new Date(observedAt.getTime() + 60_000),
    admitted_at: observedAt,
    ready_at: observedAt,
    last_seen_at: observedAt,
    retired_at: null,
    retire_reason: null,
  }).execute();
  await database.insertInto('workflow.agent_runtime_projections').values({
    server_id: serverId,
    session_id: agentSessionId,
    session_generation: 1,
    gateway_id: agentGatewayId,
    state_sequence: 1,
    runtime_ready: true,
    hello_json: JSON.stringify({ serverId }),
    state_report_json: JSON.stringify({ containers: [] }),
    docker_daemon_json: null,
    hello_observed_at: observedAt,
    state_observed_at: observedAt,
  }).execute();
  await database.insertInto('infra.images').values({
    id: imageId,
    name: 'Proxy Image',
    docker_image: 'example/proxy:latest',
    runtime_overrides: {
      uid: 0,
      entrypoint: null,
      cmd: null,
      init: false,
    },
    description: null,
    is_active: true,
    disable_ssh: false,
    deleting: false,
    cleanup_generation: 0,
    revision: 1,
  }).execute();
  await database.insertInto('control.containers').values({
    id: containerId,
    server_id: serverId,
    owner_id: userId,
    image_id: imageId,
    created_by: userId,
    name: 'proxy-container',
    revision: 1,
    desired_generation: 1,
    image_ref: 'example/proxy:latest',
    image_default_uid: 0,
    image_runtime_overrides: {
      uid: 0,
      entrypoint: null,
      cmd: null,
      init: false,
    },
    cpu_millis: 1000,
    mem_bytes: 1024,
    disk_bytes: 4096,
    gpu_mode: 'none',
    gpu_indices: [],
    mounts_json: JSON.stringify([]),
    power_intent: ContainerPowerIntent.Running,
    lifecycle_phase: ContainerPhase.Active,
    observed_generation: 1,
    bound_runtime_id: 'runtime-a',
    quota_paths: ['/quota/a', '/quota/b'],
    runtime_spec_hash: 'runtime-spec-a',
    active_task_id: null,
    last_transition_at: new Date(),
    failure_reason: null,
    failure_code: null,
  }).execute();
  await database.insertInto('control.container_network_claims').values({
    id: randomUUID(),
    container_id: containerId,
    owner_kind: 'container',
    owner_id: containerId,
    server_id: serverId,
    network_key: '10.44.0.0/29',
    address: '10.44.0.2',
    state: 'active',
    reusable_at: null,
    cleanup_payload_json: null,
  }).execute();
  await database.insertInto('control.container_ssh_routes').values({
    container_id: containerId,
    server_id: serverId,
    runtime_id: 'runtime-a',
    macvlan_ip: '10.44.0.2',
    runtime_status: ContainerStatus.Running,
    ssh_status: 'running',
    applied_internal_key_generation: 1,
    container_host_key_fingerprint: 'SHA256:test',
    last_error: null,
    observed_at: new Date(),
  }).execute();
  return { userId, serverId, imageId, containerId };
}
