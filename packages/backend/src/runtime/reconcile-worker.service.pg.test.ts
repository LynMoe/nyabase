import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { UserStatus } from '@nyabase/common';
import { IncusError } from '../incus/index.js';
import { withPostgresTestDatabase } from '../persistence-pg/postgres-test-harness.js';
import {
  PgResourceStatusRepository,
  ReconcileWorkerService,
} from './reconcile-worker.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

function serverValues(
  id: string,
  status: 'online' | 'unreachable' | 'unknown',
) {
  return {
    id,
    name: `scan-${id.slice(0, 8)}`,
    slug: `scan-${id.slice(0, 8)}`,
    api_endpoint: 'https://incus.example.test:8443',
    server_cert_fingerprint: 'ab'.repeat(32),
    incus_version: null,
    api_extensions: [],
    system_pool_id: null,
    storage_overcommit_ratio: 1,
    parent_interface: 'eth0',
    dns_servers: [],
    status,
    last_seen_at: null,
    last_error: null,
    revision: 1,
    node_metrics_endpoint: null,
    node_metrics_server_cert_fingerprint: null,
    node_metrics_token_ciphertext: null,
    node_metrics_token_fingerprint: null,
    node_metrics_status: 'unconfigured' as const,
    node_metrics_last_success_at: null,
    node_metrics_outage_since: null,
    node_metrics_last_error: null,
    preflight_status: 'not_run' as const,
    preflight_checked_at: null,
    preflight_report: null,
  };
}

describePg('ReconcileWorkerService PostgreSQL server admission guard', () => {
  it('does not use pre-connect servers and continues scanning online servers', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const unknownServerId = randomUUID();
      const unreachableServerId = randomUUID();
      const onlineServerId = randomUUID();
      await database
        .insertInto('infra.servers')
        .values([
          serverValues(unknownServerId, 'unknown'),
          serverValues(unreachableServerId, 'unreachable'),
          serverValues(onlineServerId, 'online'),
        ])
        .execute();

      const scan = vi.fn().mockResolvedValue(undefined);
      const clients = {
        get: vi.fn().mockResolvedValue({}),
        listServerIds: vi.fn().mockResolvedValue([]),
      };
      const worker = new ReconcileWorkerService(
        { runsWorker: () => true } as never,
        {
          listPending: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
        } as never,
        {
          reapExpired: vi.fn().mockResolvedValue(0),
        } as never,
        [{ scan }] as never,
        clients as never,
        undefined,
        undefined,
        database,
      );

      await (worker as unknown as { fullScan: () => Promise<void> }).fullScan();

      expect(clients.get).toHaveBeenCalledOnce();
      expect(clients.get).toHaveBeenCalledWith(onlineServerId);
      expect(clients.get).not.toHaveBeenCalledWith(unknownServerId);
      expect(clients.get).not.toHaveBeenCalledWith(unreachableServerId);
      expect(scan).toHaveBeenCalledOnce();
      expect(scan).toHaveBeenCalledWith(
        onlineServerId,
        expect.anything(),
        expect.any(AbortSignal),
      );
    });
  });
});

describePg('ReconcileWorkerService PostgreSQL busy breaker and inventory', () => {
  it('persists busy strikes so a fresh worker still trips the breaker', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const resourceId = randomUUID();
      const resourceStatus = {
        markNeedsAttention: vi.fn().mockResolvedValue(undefined),
        markFailure: vi.fn().mockResolvedValue(undefined),
        markSucceeded: vi.fn().mockResolvedValue(undefined),
      };
      const retry = vi.fn().mockRejectedValue(new IncusError('INSTANCE_BUSY', 'retry', { action: 'start' }));
      const make = () => new ReconcileWorkerService(
        { runsWorker: () => true } as never,
        {
          listPending: vi.fn().mockResolvedValue({
            items: [{
              id: randomUUID(),
              kind: 'container.update',
              resourceType: 'container',
              resourceId,
              serverId: randomUUID(),
              targetGeneration: 1,
              status: 'pending',
              attemptCount: 0,
              readyAt: new Date(),
              request: {},
              baseline: null,
            }],
            nextCursor: null,
          }),
          scheduleRetry: vi.fn().mockResolvedValue(undefined),
          settleForObservedGeneration: vi.fn().mockResolvedValue(undefined),
          settleOne: vi.fn().mockResolvedValue(true),
        } as never,
        {
          reapExpired: vi.fn().mockResolvedValue(0),
          claim: vi.fn().mockResolvedValue({
            resourceType: 'container',
            resourceId,
            serverId: null,
            workerId: 'pg-test',
            leaseExpiresAt: new Date(Date.now() + 60_000),
            claimedAt: new Date(),
          }),
          withLease: vi.fn(async (
            _claim: unknown,
            operation: (lease: { assertOwned: () => void }) => Promise<void>,
          ) => operation({ assertOwned: vi.fn() })),
        } as never,
        [{
          supports: () => true,
          reconcile: retry,
        }] as never,
        undefined,
        resourceStatus as never,
        undefined,
        database,
      );

      const first = make();
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await first.runOnce();
      }
      expect(resourceStatus.markNeedsAttention).not.toHaveBeenCalled();

      const second = make();
      await second.runOnce();

      const strikes = await database
        .selectFrom('control.reconcile_busy_strikes')
        .selectAll()
        .where('resource_type', '=', 'container')
        .where('resource_id', '=', resourceId)
        .execute();
      expect(strikes).toHaveLength(5);
      expect(resourceStatus.markNeedsAttention).toHaveBeenCalledOnce();
    });
  });

  it('keeps lifecycle_phase when marking a running container as needing attention', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const userId = randomUUID();
      const serverId = randomUUID();
      const poolId = randomUUID();
      const imageId = randomUUID();
      const containerId = randomUUID();
      await database.insertInto('iam.users').values({
        id: userId,
        numeric_id: 42,
        username: `busy-${userId.slice(0, 8)}`,
        password_hash: 'unused',
        display_name: 'Busy Strike User',
        status: UserStatus.Active,
        auth_version: 1,
        authz_version: 1,
      }).execute();
      await database.insertInto('infra.servers').values(serverValues(serverId, 'online')).execute();
      await database.insertInto('infra.storage_pools').values({
        id: poolId,
        server_id: serverId,
        incus_name: 'default',
        driver: 'dir',
        resize_family: 'quota_online',
        root_disk_capable: true,
        shareable: false,
        block_filesystem: null,
        shared_backend_id: null,
        total_bytes: 10_000,
        used_bytes: 0,
        quota_effective: true,
        display_name: null,
        registered: true,
        last_observed_at: new Date(),
        revision: 1,
      }).execute();
      await database.insertInto('infra.images').values({
        id: imageId,
        alias: `busy-${imageId.slice(0, 8)}`,
        fingerprint: 'ab'.repeat(32),
        description: null,
        login_user: 'root',
        min_root_size_bytes: 100,
        network_managed_externally: true,
        is_active: true,
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
        name: `busy-${containerId.slice(0, 8)}`,
        revision: 1,
        generation: 1,
        observed_generation: 1,
        image_alias: 'busy',
        image_fingerprint: 'ab'.repeat(32),
        root_pool_id: poolId,
        root_size_bytes: 1000,
        root_size_pending_bytes: null,
        cpu_millis: 1000,
        mem_bytes: 256,
        extensions: {},
        nesting: true,
        syscall_intercept: true,
        power_intent: 'running',
        lifecycle_phase: 'active',
        instance_name: `nyc-${containerId.replaceAll('-', '')}`,
        needs_attention: false,
        failure_code: null,
        failure_reason: null,
        last_transition_at: new Date(),
      }).execute();

      const status = new PgResourceStatusRepository(database);
      await status.markNeedsAttention('container', containerId, {
        code: 'RESOURCE_NEEDS_ATTENTION',
        message: 'Instance remained busy for five attempts within five minutes',
        details: {},
      });

      const row = await database
        .selectFrom('control.containers')
        .select(['lifecycle_phase', 'needs_attention', 'failure_code'])
        .where('id', '=', containerId)
        .executeTakeFirstOrThrow();
      expect(row.lifecycle_phase).toBe('active');
      expect(row.needs_attention).toBe(true);
      expect(row.failure_code).toBe('RESOURCE_NEEDS_ATTENTION');
    });
  });

  it('writes pool used/total during a full scan', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = randomUUID();
      const poolId = randomUUID();
      await database.insertInto('infra.servers').values(serverValues(serverId, 'online')).execute();
      await database.insertInto('infra.storage_pools').values({
        id: poolId,
        server_id: serverId,
        incus_name: 'default',
        driver: 'dir',
        resize_family: 'quota_online',
        root_disk_capable: true,
        shareable: false,
        block_filesystem: null,
        shared_backend_id: null,
        total_bytes: null,
        used_bytes: null,
        quota_effective: true,
        display_name: null,
        registered: true,
        last_observed_at: null,
        revision: 1,
      }).execute();

      const getResources = vi.fn().mockResolvedValue({ metadata: {} });
      const getStoragePoolResources = vi.fn().mockResolvedValue({
        metadata: { space: { used: 250, total: 4000 } },
      });
      const worker = new ReconcileWorkerService(
        { runsWorker: () => true } as never,
        {
          listPending: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
        } as never,
        {
          reapExpired: vi.fn().mockResolvedValue(0),
        } as never,
        [] as never,
        {
          get: vi.fn().mockResolvedValue({ getResources, getStoragePoolResources }),
          listServerIds: vi.fn().mockResolvedValue([]),
        } as never,
        undefined,
        undefined,
        database,
      );

      await (worker as unknown as { fullScan: () => Promise<void> }).fullScan();

      const pool = await database
        .selectFrom('infra.storage_pools')
        .select(['used_bytes', 'total_bytes'])
        .where('id', '=', poolId)
        .executeTakeFirstOrThrow();
      expect(pool.used_bytes).toBe('250');
      expect(pool.total_bytes).toBe('4000');
    });
  });
});
