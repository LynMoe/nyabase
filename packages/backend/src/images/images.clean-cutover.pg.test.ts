import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ServerStatus } from '@nyabase/common';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { withPostgresTestDatabase } from '../persistence-pg/postgres-test-harness.js';
import { ImagesService } from './images.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePg('clean Incus image assignment contract', () => {
  it('allows admins to fill min_root_size_bytes when automatic discovery is unavailable', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const imageId = randomUUID();
      await database.insertInto('infra.images').values({
        id: imageId,
        name: 'Admin filled root',
        alias: 'admin-min-root',
        fingerprint: null,
        description: null,
        login_user: 'root',
        min_root_size_bytes: null,
        network_managed_externally: false,
        is_active: true,
        deleting: false,
        cleanup_generation: 0,
        revision: 1,
      }).execute();

      const service = new ImagesService(
        database,
        new PgTransactionManager(database),
        { assertActorCapabilitiesInTransaction: vi.fn() } as never,
        { append: vi.fn() } as never,
        { ensurePending: vi.fn() } as never,
        { wake: vi.fn() } as never,
      );

      const updated = await service.update('actor-1', imageId, {
        expectedRevision: 1,
        minRootSizeBytes: 2_147_483_648,
      });
      expect(updated).toMatchObject({
        id: imageId,
        minRootSizeBytes: 2_147_483_648,
        revision: 2,
      });
      await expect(database
        .selectFrom('infra.images')
        .select(['min_root_size_bytes', 'revision'])
        .where('id', '=', imageId)
        .executeTakeFirstOrThrow())
        .resolves.toMatchObject({
          min_root_size_bytes: '2147483648',
          revision: '2',
        });
    });
  });

  it('keeps assignment PUT idempotent and schedules fingerprint-safe cleanup', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const imageId = randomUUID();
      const serverId = randomUUID();
      await database.insertInto('infra.images').values({
        id: imageId,
        name: 'Ubuntu',
        alias: 'ubuntu',
        fingerprint: 'a'.repeat(64),
        description: null,
        login_user: 'root',
        min_root_size_bytes: null,
        network_managed_externally: false,
        is_active: true,
        deleting: false,
        cleanup_generation: 0,
        revision: 1,
      }).execute();
      await database.insertInto('infra.servers').values({
        id: serverId,
        name: 'Incus node',
        slug: `node-${serverId.slice(0, 8)}`,
        api_endpoint: 'https://incus.example.test:8443',
        server_cert_fingerprint: null,
        incus_version: null,
        api_extensions: [],
        system_pool_id: null,
        storage_overcommit_ratio: 1,
        parent_interface: 'eth0',
        dns_servers: ['10.20.0.1'],
        gpu_runtime_available: false,
        status: ServerStatus.Unknown,
        last_seen_at: null,
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
        preflight_status: 'not_run',
        preflight_checked_at: null,
        preflight_report: null,
      }).execute();

      const intents = {
        ensurePending: vi.fn(async (input: {
          kind: 'image_assignment.ensure' | 'image_assignment.delete';
          resourceId: string;
          targetGeneration: number;
        }) => ({
          id: randomUUID(),
          kind: input.kind,
          resourceType: 'image_assignment' as const,
          resourceId: input.resourceId,
          serverId,
          requestedBy: 'actor-1',
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
      const service = new ImagesService(
        database,
        new PgTransactionManager(database),
        { assertActorCapabilitiesInTransaction: vi.fn() } as never,
        { append: vi.fn() } as never,
        intents as never,
        { wake: vi.fn() } as never,
      );

      const first = await service.ensureAssignment('actor-1', imageId, serverId);
      const second = await service.ensureAssignment('actor-1', imageId, serverId, 1);
      expect(first.assignment).toMatchObject({
        imageId,
        serverId,
        generation: 1,
        lifecyclePhase: 'provisioning',
      });
      expect(second.assignment).toMatchObject({
        id: first.assignment.id,
        generation: 1,
        lifecyclePhase: 'provisioning',
      });
      await expect(database
        .selectFrom('infra.image_server_assignments')
        .selectAll()
        .where('image_id', '=', imageId)
        .execute())
        .resolves.toHaveLength(1);
      expect(intents.ensurePending).toHaveBeenCalledTimes(2);

      await database.updateTable('infra.image_server_assignments')
        .set({
          lifecycle_phase: 'active',
          managed_fingerprint: 'a'.repeat(64),
          observed_fingerprint: 'a'.repeat(64),
        })
        .where('id', '=', first.assignment.id)
        .execute();
      const deleted = await service.deleteAssignment('actor-1', imageId, serverId, 1);
      expect(deleted.assignment).toMatchObject({
        id: first.assignment.id,
        generation: 2,
        lifecyclePhase: 'deleting',
        managedFingerprint: 'a'.repeat(64),
      });
      expect(deleted.intents).toHaveLength(1);
      expect(deleted.intents[0]?.kind).toBe('image_assignment.delete');
    });
  });

  it('serializes image deletion with assignment creation on the image row', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const imageId = randomUUID();
      const serverId = randomUUID();
      await database.insertInto('infra.images').values({
        id: imageId,
        name: 'Concurrent image',
        alias: 'concurrent-image',
        fingerprint: 'b'.repeat(64),
        description: null,
        login_user: 'root',
        min_root_size_bytes: null,
        network_managed_externally: false,
        is_active: true,
        deleting: false,
        cleanup_generation: 0,
        revision: 1,
      }).execute();
      await database.insertInto('infra.servers').values({
        id: serverId,
        name: 'Concurrent node',
        slug: `concurrent-${serverId.slice(0, 8)}`,
        api_endpoint: 'https://incus.example.test:8443',
        server_cert_fingerprint: null,
        incus_version: null,
        api_extensions: [],
        system_pool_id: null,
        storage_overcommit_ratio: 1,
        parent_interface: 'eth0',
        dns_servers: ['10.21.0.1'],
        gpu_runtime_available: false,
        status: ServerStatus.Unknown,
        last_seen_at: null,
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
        preflight_status: 'not_run',
        preflight_checked_at: null,
        preflight_report: null,
      }).execute();

      const intents = {
        ensurePending: vi.fn(async (input: {
          kind: string;
          resourceId: string;
          targetGeneration: number;
        }) => ({
          id: randomUUID(),
          kind: input.kind,
          resourceType: 'image_assignment' as const,
          resourceId: input.resourceId,
          serverId,
          requestedBy: 'actor-1',
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
      const service = new ImagesService(
        database,
        new PgTransactionManager(database),
        { assertActorCapabilitiesInTransaction: vi.fn() } as never,
        { append: vi.fn() } as never,
        intents as never,
        { wake: vi.fn() } as never,
      );

      const results = await Promise.allSettled([
        service.delete('actor-1', imageId),
        service.ensureAssignment('actor-1', imageId, serverId),
      ]);
      expect(results[0]?.status).toBe('fulfilled');
      if (results[1]?.status === 'rejected') {
        expect(results[1].reason.response.code).toBe('IMAGE_NOT_ASSIGNABLE');
      }

      const image = await database.selectFrom('infra.images')
        .select(['is_active', 'deleting'])
        .where('id', '=', imageId)
        .executeTakeFirstOrThrow();
      expect(image).toMatchObject({ is_active: false, deleting: true });

      const assignments = await database.selectFrom('infra.image_server_assignments')
        .select(['lifecycle_phase'])
        .where('image_id', '=', imageId)
        .execute();
      expect(assignments.every((assignment) => assignment.lifecycle_phase === 'deleting')).toBe(true);
    });
  });
});
