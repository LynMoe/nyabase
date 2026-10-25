import { randomUUID } from 'node:crypto';
import { UserStatus } from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { ContainerReconciler } from './container-reconciler.service.js';
import { ContainerReconcileStore } from './container-reconcile.store.js';
import { IntentRepository } from '../reconcile/intent.repository.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

function serverValues(
  id: string,
  status: 'online' | 'unreachable' | 'unknown',
) {
  return {
    id,
    name: `scan-${id.slice(0, 8)}`,
    slug: `scan-${id.slice(0, 8)}`,
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
    node_metrics_status: 'unknown' as const,
    node_metrics_last_success_at: null,
    node_metrics_outage_since: null,
    node_metrics_last_error: null,
    preflight_status: 'not_run' as const,
    preflight_checked_at: null,
    preflight_report: null,
  };
}


type Db = Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0]['database'];

/** A user, an online server with a pool, an image and one running, active container. */
async function seedRunningContainer(database: Db): Promise<{ serverId: string; containerId: string }> {
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
    observed_revision: 1,
    image_alias: 'busy',
    image_fingerprint: 'ab'.repeat(32),
    root_pool_id: poolId,
    root_size_bytes: 1000,
    root_size_pending_bytes: null,
    mem_bytes: 256,
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
  return { serverId, containerId };
}

describePg('ContainerReconciler PostgreSQL status', () => {
  it('keeps lifecycle_phase when parking a running container for attention', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { containerId } = await seedRunningContainer(database);
      const reconciler = new ContainerReconciler(new ContainerReconcileStore(database, {} as never),
        {} as never,
        {} as never,
        {} as never,
        { register: vi.fn() } as never,
        {} as never,
        {} as never,
        { onChange: vi.fn() } as never,
        {} as never,
        {} as never,
      );
      await reconciler.markFailure(containerId, {
        code: 'RESOURCE_NEEDS_ATTENTION',
        message: 'Instance remained busy for five attempts within five minutes',
        details: {},
      }, true);

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

  it('stores the route status in ContainerStatus form, not the Incus casing', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { serverId, containerId } = await seedRunningContainer(database);
      const instanceName = `nyc-${containerId.replaceAll('-', '')}`;
      await database.insertInto('control.container_ssh_routes').values({
        container_id: containerId,
        server_id: serverId,
        instance_name: instanceName,
        routed_ip: '10.8.255.10',
        instance_status: 'unknown',
        instance_started_at: null,
        ssh_status: 'unknown',
        last_error: null,
        observed_at: new Date(),
      }).execute();
      const row = await database.selectFrom('control.containers').selectAll()
        .where('id', '=', containerId).executeTakeFirstOrThrow();

      await new ContainerReconcileStore(database, {} as never).recordObservation(
        row as never,
        { name: instanceName } as never,
        { status: 'Running', started_at: null } as never,
        false,
        { status: 'running', lastError: null } as never,
        null,
      );

      const route = await database.selectFrom('control.container_ssh_routes')
        .select('instance_status').where('container_id', '=', containerId).executeTakeFirstOrThrow();
      expect(route.instance_status).toBe('running');
    });
  });

  it('never lets a stale create observation undo a delete accepted meanwhile', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { containerId } = await seedRunningContainer(database);
      await database.updateTable('control.containers')
        .set({ lifecycle_phase: 'provisioning', observed_revision: null })
        .where('id', '=', containerId).execute();
      const createPass = await database.selectFrom('control.containers').selectAll()
        .where('id', '=', containerId).executeTakeFirstOrThrow();
      // The delete lands while the create pass is still talking to Incus.
      await database.updateTable('control.containers')
        .set({ lifecycle_phase: 'deleting', power_intent: 'stopped', revision: 2 })
        .where('id', '=', containerId).execute();

      const store = new ContainerReconcileStore(database, {} as never);
      await store.recordObservation(
        createPass as never,
        { name: createPass.instance_name } as never,
        { status: 'Running', started_at: null } as never,
        false,
        { status: 'running', lastError: null },
        123n,
      );
      await store.markSucceeded(containerId, 1);

      const row = await database.selectFrom('control.containers')
        .select(['lifecycle_phase', 'revision', 'observed_revision', 'root_used_bytes'])
        .where('id', '=', containerId).executeTakeFirstOrThrow();
      expect(row.lifecycle_phase).toBe('deleting');
      expect(row.revision).toBe(2);
      expect(row.observed_revision).toBeNull();
    });
  });

  it('moves provisioning to active only for the revision it observed', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { containerId } = await seedRunningContainer(database);
      await database.updateTable('control.containers')
        .set({ lifecycle_phase: 'provisioning', observed_revision: null })
        .where('id', '=', containerId).execute();
      const row = await database.selectFrom('control.containers').selectAll()
        .where('id', '=', containerId).executeTakeFirstOrThrow();
      await new ContainerReconcileStore(database, {} as never).recordObservation(
        row as never,
        { name: row.instance_name } as never,
        { status: 'Running', started_at: null } as never,
        false,
        { status: 'running', lastError: null },
        null,
      );
      const after = await database.selectFrom('control.containers')
        .select(['lifecycle_phase', 'observed_revision'])
        .where('id', '=', containerId).executeTakeFirstOrThrow();
      expect(after).toEqual({ lifecycle_phase: 'active', observed_revision: 1 });
    });
  });

  it('releases a root shrink reservation only once Incus applied the size, or on a current revert', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { containerId } = await seedRunningContainer(database);
      await database.updateTable('control.containers')
        .set({ root_shrink_reserved_bytes: 8_000_000_000 })
        .where('id', '=', containerId).execute();
      const store = new ContainerReconcileStore(database, {} as never);
      const reserved = async () => (await database.selectFrom('control.containers')
        .select(['root_size_bytes', 'root_shrink_reserved_bytes'])
        .where('id', '=', containerId).executeTakeFirstOrThrow());
      const observe = async (quotaPending: boolean) => {
        const row = await database.selectFrom('control.containers').selectAll()
          .where('id', '=', containerId).executeTakeFirstOrThrow();
        await store.recordObservation(
          row as never,
          { name: row.instance_name } as never,
          { status: 'Running', started_at: null } as never,
          quotaPending,
          { status: 'running', lastError: null },
          null,
        );
      };

      // Incus applies the quota at the next start: it still holds the larger size.
      await observe(true);
      expect((await reserved()).root_shrink_reserved_bytes).toBe('8000000000');
      await observe(false);
      expect((await reserved()).root_shrink_reserved_bytes).toBeNull();

      // A revert of a superseded revision changes nothing; the current one releases it.
      await database.updateTable('control.containers')
        .set({ root_shrink_reserved_bytes: 8_000_000_000, revision: 2 })
        .where('id', '=', containerId).execute();
      await store.revertImpossibleRootShrink(containerId, 1, 8_000_000_000n, null, 'ROOT_SHRINK_BELOW_USAGE');
      expect((await reserved()).root_shrink_reserved_bytes).toBe('8000000000');
      await store.revertImpossibleRootShrink(containerId, 2, 8_000_000_000n, null, 'ROOT_SHRINK_BELOW_USAGE');
      expect(await reserved()).toEqual({ root_size_bytes: '8000000000', root_shrink_reserved_bytes: null });
    });
  });

  it('refreshes a route observation only when the scan sees what the route says', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { serverId, containerId } = await seedRunningContainer(database);
      const instanceName = `nyc-${containerId.replaceAll('-', '')}`;
      const old = new Date(Date.now() - 10 * 60_000);
      await database.insertInto('control.container_ssh_routes').values({
        container_id: containerId,
        server_id: serverId,
        instance_name: instanceName,
        routed_ip: '10.0.0.5',
        instance_status: 'running',
        instance_started_at: null,
        ssh_status: 'running',
        last_error: null,
        observed_at: old,
      }).execute();
      const store = new ContainerReconcileStore(database, {} as never);
      const observedAt = async () => (await database.selectFrom('control.container_ssh_routes')
        .select('observed_at').where('container_id', '=', containerId).executeTakeFirstOrThrow()).observed_at;

      await store.confirmRouteObservation(containerId, instanceName, 'stopped');
      expect((await observedAt()).getTime()).toBe(old.getTime());
      await store.confirmRouteObservation(containerId, instanceName, 'running');
      expect((await observedAt()).getTime()).toBeGreaterThan(Date.now() - 60_000);
    });
  });

  it('does not re-queue a scan intent that already failed for the same revision', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { serverId, containerId } = await seedRunningContainer(database);
      const intents = new IntentRepository(database, { wake: vi.fn() } as never);
      const store = new ContainerReconcileStore(database, intents);
      const desired = { id: containerId, revision: 1, server_id: serverId };
      await store.enqueueScanIntent(desired, 'container.update');
      await intents.settleForObservedRevision('container', containerId, 1, {
        outcome: 'failed',
        failure: { code: 'GPU_MUTATION_REQUIRES_STOP', message: 'stop first' },
        placementServerId: serverId,
      });
      await store.enqueueScanIntent(desired, 'container.update');
      await store.enqueueScanIntent(desired, 'container.update');
      const rows = await database.selectFrom('control.intents').select(['status'])
        .where('resource_id', '=', containerId).execute();
      expect(rows).toEqual([{ status: 'failed' }]);

      // After the back-off the scan tries again.
      await database.updateTable('control.intents')
        .set({ settled_at: new Date(Date.now() - 2 * 60 * 60_000) })
        .where('resource_id', '=', containerId).execute();
      await store.enqueueScanIntent(desired, 'container.update');
      expect(await database.selectFrom('control.intents').select('id')
        .where('resource_id', '=', containerId).execute()).toHaveLength(2);

      // A newer revision is scanned again at once.
      await store.enqueueScanIntent({ ...desired, revision: 2 }, 'container.update');
      expect(await database.selectFrom('control.intents').select('id')
        .where('resource_id', '=', containerId).execute()).toHaveLength(3);
    });
  });
});
