import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ServerStatus } from '@nyabase/common';
import { withPostgresTestDatabase } from '../persistence-pg/postgres-test-harness.js';
import { InfrastructureRepository } from './infrastructure.repository.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePg('clean Incus infrastructure repository', () => {
  it('keeps discovery observations separate from registration revisions', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const repository = new InfrastructureRepository(database);
      const serverId = randomUUID();
      await repository.insertServer({
        id: serverId,
        name: 'Incus node',
        slug: `incus-${serverId.slice(0, 8)}`,
        api_endpoint: 'https://incus.example.test:8443',
        server_cert_fingerprint: null,
        incus_version: null,
        api_extensions: [],
        system_pool_id: null,
        storage_overcommit_ratio: 1,
        parent_interface: 'eth0',
        dns_servers: ['10.20.0.1'],
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
      });

      const first = await repository.upsertStoragePoolDiscovery(randomUUID(), {
        serverId,
        incusName: 'default',
        driver: 'dir',
        resizeFamily: 'quota_online',
        rootDiskCapable: true,
        shareable: false,
        blockFilesystem: null,
        totalBytes: 100,
        usedBytes: 20,
        quotaEffective: false,
      });
      expect(first.registered).toBe(false);

      const registered = await repository.patchStoragePool(
        first.id,
        1,
        { registered: true },
      );
      expect(registered?.registered).toBe(true);

      const observed = await repository.upsertStoragePoolDiscovery(randomUUID(), {
        serverId,
        incusName: 'default',
        driver: 'dir',
        resizeFamily: 'quota_online',
        rootDiskCapable: true,
        shareable: false,
        blockFilesystem: null,
        totalBytes: 200,
        usedBytes: 30,
        quotaEffective: true,
      });
      expect(observed.id).toBe(first.id);
      expect(observed.registered).toBe(true);
      expect(Number(observed.revision)).toBe(2);
      expect(observed.total_bytes).toBe('200');
    });
  });

  it('supports image assignment discovery without legacy runtime fields', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const repository = new InfrastructureRepository(database);
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
      const assignmentId = randomUUID();
      await repository.insertImageAssignment({
        id: assignmentId,
        image_id: imageId,
        server_id: serverId,
        generation: 1,
        observed_fingerprint: null,
        managed_fingerprint: null,
        lifecycle_phase: 'provisioning',
        needs_attention: false,
        failure_code: null,
        failure_reason: null,
        last_observed_at: null,
      });

      await expect(repository.findImageAssignmentById(assignmentId))
        .resolves.toMatchObject({
          id: assignmentId,
          image_id: imageId,
          server_id: serverId,
          generation: 1,
        });
    });
  });
});
