import { randomUUID } from 'node:crypto';
import { UserStatus } from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { ContainerReconciler } from './container-reconciler.service.js';

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


describePg('ContainerReconciler PostgreSQL status', () => {
  it('keeps lifecycle_phase when parking a running container for attention', async () => {
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
        observed_revision: 1,
        image_alias: 'busy',
        image_fingerprint: 'ab'.repeat(32),
        root_pool_id: poolId,
        root_size_bytes: 1000,
        root_size_pending_bytes: null,
        cpu_millis: 1000,
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

      const reconciler = new ContainerReconciler(
        database,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        { register: vi.fn() } as never,
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
});
