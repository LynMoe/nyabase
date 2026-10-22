import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ServerStatus, parseAgentSecret } from '@nyabase/common';
import { AgentCredentialVerifier, agentSecretDigest } from '../incus/agent-credentials.js';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { VOLUME_DESTROY_PLACEMENT_ID } from '../reconcile/reconcile-claim.repository.js';
import { ServersService } from './servers.service.js';
import { AgentEnrollmentService } from './agent-enrollment.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePg('server agent onboarding and removal', () => {
  it('issues a one-time enrollment token and trades it for the agent credential exactly once', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const transactions = new PgTransactionManager(database);
      const access = { assertActorCapabilitiesInTransaction: vi.fn() };
      const audit = { append: vi.fn() };
      const agents = { disconnect: vi.fn(), isConnected: vi.fn(() => false) };
      const enrollment = new AgentEnrollmentService(
        database,
        transactions,
        access as never,
        audit as never,
        agents as never,
      );
      const service = new ServersService(
        database,
        transactions,
        access as never,
        audit as never,
        { invalidate: vi.fn() } as never,
        agents as never,
        enrollment,
        { wake: vi.fn() } as never,
      );
      const created = await service.create(randomUUID(), {
        name: 'agent node',
        slug: `agent-${randomUUID().slice(0, 8)}`,
        parentInterface: 'vmbr0',
        dnsServers: [],
        reservedCpus: [0],
      });
      expect(created.reservedCpus).toEqual([0]);
      expect(created.agent).toMatchObject({ connected: false, enrolled: false });
      const token = created.enrollment.enrollmentToken;
      expect(parseAgentSecret('enrollment', token)?.serverId).toBe(created.id);
      const stored = await database
        .selectFrom('infra.servers')
        .select(['agent_enrollment_token_hash', 'agent_credential_hash'])
        .where('id', '=', created.id)
        .executeTakeFirstOrThrow();
      expect(stored.agent_enrollment_token_hash).toBe(agentSecretDigest(token));
      expect(stored.agent_credential_hash).toBeNull();

      const enrolled = await enrollment.enroll({ enrollmentToken: token, hostname: 'worker-1' });
      expect(enrolled.serverId).toBe(created.id);
      await expect(new AgentCredentialVerifier(database).authenticate(`Bearer ${enrolled.credential}`))
        .resolves.toBe(created.id);
      await expect(new AgentCredentialVerifier(database).authenticate('Bearer nyak.x.y')).resolves.toBeUndefined();
      expect(agents.disconnect).toHaveBeenCalledWith(created.id);
      await expect(enrollment.enroll({ enrollmentToken: token, hostname: 'worker-1' }))
        .rejects.toMatchObject({ status: 401 });

      const rotated = await enrollment.rotate(randomUUID(), created.id, 1);
      await database
        .updateTable('infra.servers')
        .set({ agent_enrollment_expires_at: new Date(Date.now() - 1_000) })
        .where('id', '=', created.id)
        .execute();
      await expect(enrollment.enroll({ enrollmentToken: rotated.enrollmentToken, hostname: 'worker-1' }))
        .rejects.toMatchObject({ status: 401 });
      // The running agent's credential survives an unused rotation.
      await expect(new AgentCredentialVerifier(database).authenticate(`Bearer ${enrolled.credential}`))
        .resolves.toBe(created.id);
    });
  });

  it('rejects stale revision and control-plane-cascades referenced servers', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = randomUUID();
      await database
        .insertInto('infra.servers')
        .values({
          id: serverId,
          name: 'Guarded node',
          slug: `guarded-${serverId.slice(0, 8)}`,
          incus_version: null,
          api_extensions: [],
          system_pool_id: null,
          storage_overcommit_ratio: 1,
          parent_interface: 'eth0',
          dns_servers: ['10.20.1.1'],
          status: ServerStatus.Unknown,
          last_seen_at: null,
          last_error: null,
          revision: 3,
          node_metrics_status: 'unknown',
          node_metrics_last_success_at: null,
          node_metrics_outage_since: null,
          node_metrics_last_error: null,
          preflight_status: 'not_run',
          preflight_checked_at: null,
          preflight_report: null,
        })
        .execute();
      const poolId = randomUUID();
      await database
        .insertInto('infra.storage_pools')
        .values({
          id: poolId,
          server_id: serverId,
          incus_name: 'default',
          driver: 'dir',
          resize_family: 'quota_online',
          root_disk_capable: true,
          shareable: false,
          block_filesystem: null,
          shared_backend_id: null,
          total_bytes: 100,
          used_bytes: 10,
          quota_effective: true,
          display_name: null,
          registered: false,
          last_observed_at: null,
          revision: 1,
        })
        .execute();

      const service = new ServersService(
        database,
        new PgTransactionManager(database),
        { assertActorCapabilitiesInTransaction: vi.fn() } as never,
        { append: vi.fn() } as never,
        { invalidate: vi.fn() } as never,
        { disconnect: vi.fn(), isConnected: vi.fn(() => false) } as never,
        {} as never,
        { wake: vi.fn() } as never,
      );

      await expect(service.delete('actor-1', serverId, 2)).rejects.toMatchObject({
        response: { code: 'REVISION_CONFLICT' },
      });
      await expect(service.delete('actor-1', serverId, 3)).resolves.toBeUndefined();
      await expect(
        database
          .selectFrom('infra.servers')
          .select('id')
          .where('id', '=', serverId)
          .executeTakeFirst(),
      ).resolves.toBeUndefined();
      await expect(
        database
          .selectFrom('infra.storage_pools')
          .select('id')
          .where('server_id', '=', serverId)
          .executeTakeFirst(),
      ).resolves.toBeUndefined();
    });
  });

  it('control-plane-cascades a referenced server without Incus and preserves peer shared catalogs', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const ownerId = randomUUID();
      const serverS = randomUUID();
      const serverT = randomUUID();
      const imageId = randomUUID();
      const backendId = randomUUID();
      const poolS = randomUUID();
      const poolT = randomUUID();
      const cephS = randomUUID();
      const cephT = randomUUID();
      const containerId = randomUUID();
      const localVolumeId = randomUUID();
      const sharedBothId = randomUUID();
      const sharedOnlySId = randomUUID();
      const sharedClaimedId = randomUUID();
      await database.insertInto('iam.users').values({
        id: ownerId,
        numeric_id: 8,
        username: `cascade-${ownerId.slice(0, 8)}`,
        password_hash: 'x',
        display_name: 'cascade',
        status: 'active',
        auth_version: 0,
      }).execute();
      await database.insertInto('infra.servers').values([
        {
          id: serverS,
          name: 'cascade-s',
          slug: `cascade-s-${serverS.slice(0, 8)}`,
          incus_version: null,
          api_extensions: [],
          system_pool_id: null,
          storage_overcommit_ratio: 1,
          parent_interface: 'eth0',
          dns_servers: [],
          status: ServerStatus.Online,
          last_seen_at: null,
          last_error: null,
          revision: 4,
          node_metrics_status: 'unknown',
          node_metrics_last_success_at: null,
          node_metrics_outage_since: null,
          node_metrics_last_error: null,
          preflight_status: 'not_run',
          preflight_checked_at: null,
          preflight_report: null,
        },
        {
          id: serverT,
          name: 'cascade-t',
          slug: `cascade-t-${serverT.slice(0, 8)}`,
          incus_version: null,
          api_extensions: [],
          system_pool_id: null,
          storage_overcommit_ratio: 1,
          parent_interface: 'eth0',
          dns_servers: [],
          status: ServerStatus.Online,
          last_seen_at: null,
          last_error: null,
          revision: 1,
          node_metrics_status: 'unknown',
          node_metrics_last_success_at: null,
          node_metrics_outage_since: null,
          node_metrics_last_error: null,
          preflight_status: 'not_run',
          preflight_checked_at: null,
          preflight_report: null,
        },
      ]).execute();
      await database.insertInto('infra.storage_pools').values([
        {
          id: poolS,
          server_id: serverS,
          incus_name: 'default',
          driver: 'dir',
          resize_family: 'quota_online',
          root_disk_capable: true,
          shareable: false,
          block_filesystem: null,
          shared_backend_id: null,
          total_bytes: 1000,
          used_bytes: 10,
          quota_effective: true,
          display_name: null,
          registered: true,
          last_observed_at: null,
          revision: 1,
        },
        {
          id: poolT,
          server_id: serverT,
          incus_name: 'default',
          driver: 'dir',
          resize_family: 'quota_online',
          root_disk_capable: true,
          shareable: false,
          block_filesystem: null,
          shared_backend_id: null,
          total_bytes: 1000,
          used_bytes: 10,
          quota_effective: true,
          display_name: null,
          registered: true,
          last_observed_at: null,
          revision: 1,
        },
      ]).execute();
      await database.insertInto('infra.shared_backends').values({
        id: backendId,
        name: 'cascade-ceph',
        display_name: null,
        identity_key: `cephfs:ceph/${backendId}/data`,
        ceph_fsid: randomUUID(),
        total_bytes: 1000,
        used_bytes: 0,
        overcommit_ratio: 1,
        revision: 1,
      }).execute();
      await database.insertInto('infra.storage_pools').values([
        {
          id: cephS,
          server_id: serverS,
          incus_name: 'cephfs-s',
          driver: 'cephfs',
          resize_family: 'quota_online',
          root_disk_capable: false,
          shareable: true,
          block_filesystem: null,
          shared_backend_id: backendId,
          total_bytes: 1000,
          used_bytes: 0,
          quota_effective: true,
          display_name: null,
          registered: true,
          last_observed_at: null,
          revision: 1,
        },
        {
          id: cephT,
          server_id: serverT,
          incus_name: 'cephfs-t',
          driver: 'cephfs',
          resize_family: 'quota_online',
          root_disk_capable: false,
          shareable: true,
          block_filesystem: null,
          shared_backend_id: backendId,
          total_bytes: 1000,
          used_bytes: 0,
          quota_effective: true,
          display_name: null,
          registered: true,
          last_observed_at: null,
          revision: 1,
        },
      ]).execute();
      await database.updateTable('infra.servers')
        .set({ system_pool_id: poolS })
        .where('id', '=', serverS)
        .execute();
      await database.insertInto('infra.images').values({
        id: imageId,
        alias: 'base',
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
      await database.insertInto('control.containers').values({
        id: containerId,
        server_id: serverS,
        owner_id: ownerId,
        image_id: imageId,
        created_by: ownerId,
        name: 'on-s',
        revision: 1,
        observed_revision: null,
        image_alias: 'base',
        image_fingerprint: 'a'.repeat(64),
        root_pool_id: poolS,
        root_size_bytes: 100,
        root_size_pending_bytes: null,
        mem_bytes: 1_073_741_824,
        nesting: true,
        syscall_intercept: true,
        power_intent: 'stopped',
        lifecycle_phase: 'active',
        instance_name: null,
        needs_attention: false,
        failure_code: null,
        failure_reason: null,
        last_transition_at: new Date(),
      }).execute();
      await database.insertInto('control.volumes').values([
        {
          id: localVolumeId,
          owner_id: ownerId,
          pool_id: poolS,
          server_id: serverS,
          shared_backend_id: null,
          name: 'local-s',
          incus_name: `nyv-${localVolumeId.replaceAll('-', '')}`,
          size_bytes: 100,
          used_bytes: 0,
          revision: 1,
          observed_revision: 1,
          lifecycle_phase: 'active',
          needs_attention: false,
          failure_code: null,
          remove_all_committed: false,
          remove_all_server_id: null,
        },
        {
          id: sharedBothId,
          owner_id: ownerId,
          pool_id: null,
          server_id: null,
          shared_backend_id: backendId,
          name: 'shared-both',
          incus_name: `nyv-${sharedBothId.replaceAll('-', '')}`,
          size_bytes: 100,
          used_bytes: 0,
          revision: 1,
          observed_revision: 1,
          lifecycle_phase: 'active',
          needs_attention: false,
          failure_code: null,
          remove_all_committed: false,
          remove_all_server_id: null,
        },
        {
          id: sharedOnlySId,
          owner_id: ownerId,
          pool_id: null,
          server_id: null,
          shared_backend_id: backendId,
          name: 'shared-only-s',
          incus_name: `nyv-${sharedOnlySId.replaceAll('-', '')}`,
          size_bytes: 100,
          used_bytes: 0,
          revision: 1,
          observed_revision: 1,
          lifecycle_phase: 'active',
          needs_attention: false,
          failure_code: null,
          remove_all_committed: false,
          remove_all_server_id: null,
        },
        {
          id: sharedClaimedId,
          owner_id: ownerId,
          pool_id: null,
          server_id: null,
          shared_backend_id: backendId,
          name: 'shared-claimed',
          incus_name: `nyv-${sharedClaimedId.replaceAll('-', '')}`,
          size_bytes: 100,
          used_bytes: 0,
          revision: 1,
          observed_revision: 1,
          lifecycle_phase: 'deleting',
          needs_attention: false,
          failure_code: null,
          remove_all_committed: true,
          remove_all_server_id: serverS,
        },
      ]).execute();
      await database.insertInto('control.volume_placements').values([
        {
          volume_id: localVolumeId,
          server_id: serverS,
          pool_id: poolS,
          catalog_state: 'present',
          observed_revision: 1,
        },
        {
          volume_id: sharedBothId,
          server_id: serverS,
          pool_id: cephS,
          catalog_state: 'present',
          observed_revision: 1,
        },
        {
          volume_id: sharedBothId,
          server_id: serverT,
          pool_id: cephT,
          catalog_state: 'present',
          observed_revision: 1,
        },
        {
          volume_id: sharedOnlySId,
          server_id: serverS,
          pool_id: cephS,
          catalog_state: 'present',
          observed_revision: 1,
        },
        {
          volume_id: sharedClaimedId,
          server_id: serverS,
          pool_id: cephS,
          catalog_state: 'present',
          observed_revision: 1,
        },
      ]).execute();
      await database.insertInto('control.volume_attachments').values({
        id: randomUUID(),
        container_id: containerId,
        volume_id: sharedBothId,
        device_name: `nyd-${containerId.replaceAll('-', '')}`,
        container_path: '/shared',
        read_only: false,
        bind_state: 'attached',
      }).execute();
      await database.insertInto('control.reconcile_claims').values({
        resource_type: 'volume',
        resource_id: sharedClaimedId,
        placement_server_id: VOLUME_DESTROY_PLACEMENT_ID,
        server_id: null,
        worker_id: 'destroy-worker',
        lease_expires_at: new Date('2099-01-01T00:00:00.000Z'),
      }).execute();
      const invalidate = vi.fn();
      const service = new ServersService(
        database,
        new PgTransactionManager(database),
        { assertActorCapabilitiesInTransaction: vi.fn() } as never,
        { append: vi.fn() } as never,
        { invalidate } as never,
        { disconnect: vi.fn(), isConnected: vi.fn(() => false) } as never,
        {} as never,
        { wake: vi.fn() } as never,
      );

      await expect(service.delete('actor-1', serverS, 4)).resolves.toBeUndefined();
      expect(invalidate).toHaveBeenCalledWith('server_deleted');
      expect(
        await database.selectFrom('infra.servers').select('id').where('id', '=', serverS).executeTakeFirst(),
      ).toBeUndefined();
      expect(
        await database.selectFrom('infra.servers').select('id').where('id', '=', serverT).executeTakeFirst(),
      ).toMatchObject({ id: serverT });
      expect(
        await database.selectFrom('control.containers').select('id').where('id', '=', containerId).executeTakeFirst(),
      ).toBeUndefined();
      expect(
        await database.selectFrom('control.volumes').select('id').where('id', '=', localVolumeId).executeTakeFirst(),
      ).toBeUndefined();
      expect(
        await database.selectFrom('control.volumes').select('id').where('id', '=', sharedOnlySId).executeTakeFirst(),
      ).toBeUndefined();
      expect(
        await database.selectFrom('control.volumes').select(['id', 'remove_all_committed'])
          .where('id', '=', sharedClaimedId).executeTakeFirst(),
      ).toMatchObject({ id: sharedClaimedId, remove_all_committed: true });
      expect(
        await database.selectFrom('control.volumes').select('id').where('id', '=', sharedBothId).executeTakeFirst(),
      ).toMatchObject({ id: sharedBothId });
      const remainingPlacements = await database.selectFrom('control.volume_placements')
        .select(['volume_id', 'server_id'])
        .where('volume_id', '=', sharedBothId)
        .execute();
      expect(remainingPlacements).toEqual([{ volume_id: sharedBothId, server_id: serverT }]);
      expect(
        await database.selectFrom('control.volume_attachments').select('id')
          .where('volume_id', '=', sharedBothId).execute(),
      ).toHaveLength(0);
    });
  });

  it('does not GC a never-mounted shared volume when deleting an unrelated server', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const ownerId = randomUUID();
      const unrelated = randomUUID();
      const peer = randomUUID();
      const backendId = randomUUID();
      const volumeId = randomUUID();
      const unrelatedPool = randomUUID();
      const peerCeph = randomUUID();
      await database.insertInto('iam.users').values({
        id: ownerId,
        numeric_id: 9,
        username: `never-mounted-${ownerId.slice(0, 8)}`,
        password_hash: 'x',
        display_name: 'never-mounted',
        status: 'active',
        auth_version: 0,
      }).execute();
      await database.insertInto('infra.servers').values([
        {
          id: unrelated,
          name: 'unrelated',
          slug: `unrelated-${unrelated.slice(0, 8)}`,
          incus_version: null,
          api_extensions: [],
          system_pool_id: null,
          storage_overcommit_ratio: 1,
          parent_interface: 'eth0',
          dns_servers: [],
          status: ServerStatus.Online,
          last_seen_at: null,
          last_error: null,
          revision: 1,
          node_metrics_status: 'unknown',
          node_metrics_last_success_at: null,
          node_metrics_outage_since: null,
          node_metrics_last_error: null,
          preflight_status: 'not_run',
          preflight_checked_at: null,
          preflight_report: null,
        },
        {
          id: peer,
          name: 'peer-backend',
          slug: `peer-${peer.slice(0, 8)}`,
          incus_version: null,
          api_extensions: [],
          system_pool_id: null,
          storage_overcommit_ratio: 1,
          parent_interface: 'eth0',
          dns_servers: [],
          status: ServerStatus.Online,
          last_seen_at: null,
          last_error: null,
          revision: 1,
          node_metrics_status: 'unknown',
          node_metrics_last_success_at: null,
          node_metrics_outage_since: null,
          node_metrics_last_error: null,
          preflight_status: 'not_run',
          preflight_checked_at: null,
          preflight_report: null,
        },
      ]).execute();
      await database.insertInto('infra.storage_pools').values({
        id: unrelatedPool,
        server_id: unrelated,
        incus_name: 'default',
        driver: 'dir',
        resize_family: 'quota_online',
        root_disk_capable: true,
        shareable: false,
        block_filesystem: null,
        shared_backend_id: null,
        total_bytes: 1000,
        used_bytes: 10,
        quota_effective: true,
        display_name: null,
        registered: true,
        last_observed_at: null,
        revision: 1,
      }).execute();
      await database.insertInto('infra.shared_backends').values({
        id: backendId,
        name: 'never-mounted-ceph',
        display_name: null,
        identity_key: `cephfs:ceph/${backendId}/data`,
        ceph_fsid: randomUUID(),
        total_bytes: 1000,
        used_bytes: 0,
        overcommit_ratio: 1,
        revision: 1,
      }).execute();
      await database.insertInto('infra.storage_pools').values({
        id: peerCeph,
        server_id: peer,
        incus_name: 'cephfs-peer',
        driver: 'cephfs',
        resize_family: 'quota_online',
        root_disk_capable: false,
        shareable: true,
        block_filesystem: null,
        shared_backend_id: backendId,
        total_bytes: 1000,
        used_bytes: 0,
        quota_effective: true,
        display_name: null,
        registered: true,
        last_observed_at: null,
        revision: 1,
      }).execute();
      await database.insertInto('control.volumes').values({
        id: volumeId,
        owner_id: ownerId,
        pool_id: null,
        server_id: null,
        shared_backend_id: backendId,
        name: 'never-mounted',
        incus_name: `nyv-${volumeId.replaceAll('-', '')}`,
        size_bytes: 100,
        used_bytes: null,
        revision: 1,
        observed_revision: null,
        lifecycle_phase: 'active',
        needs_attention: false,
        failure_code: null,
        dir_ensured: false,
        remove_all_committed: false,
        remove_all_server_id: null,
      }).execute();
      const service = new ServersService(
        database,
        new PgTransactionManager(database),
        { assertActorCapabilitiesInTransaction: vi.fn() } as never,
        { append: vi.fn() } as never,
        { invalidate: vi.fn() } as never,
        { disconnect: vi.fn(), isConnected: vi.fn(() => false) } as never,
        {} as never,
        { wake: vi.fn() } as never,
      );

      await expect(service.delete('actor-1', unrelated, 1)).resolves.toBeUndefined();
      expect(
        await database.selectFrom('control.volumes').select(['id', 'dir_ensured'])
          .where('id', '=', volumeId).executeTakeFirst(),
      ).toMatchObject({ id: volumeId, dir_ensured: false });
    });
  });
});
