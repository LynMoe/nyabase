import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { IntentKind, IntentResourceType } from '@nyabase/common';
import { withPostgresTestDatabase } from '../persistence-pg/postgres-test-harness.js';
import { IntentRepository } from './intent.repository.js';
import {
  MAX_ACTIVE_CLAIMS_PER_SERVER,
  ReconcileClaimRepository,
  VOLUME_DESTROY_PLACEMENT_ID,
} from './reconcile-claim.repository.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePg('Incus reconciliation intent and lease repositories', () => {
  it('uses new UUIDs for retries and settles all observed generations atomically', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = randomUUID();
      await database.insertInto('infra.servers').values({
        id: serverId,
        name: 'intent-test-server',
        slug: 'intent-test-server',
        api_endpoint: 'https://127.0.0.1:8443',
        parent_interface: null,
        dns_servers: [],
        status: 'unknown',
        api_extensions: [],
        storage_overcommit_ratio: 1,
        system_pool_id: null,
        server_cert_fingerprint: null,
        incus_version: null,
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

      const resourceId = randomUUID();
      const repository = new IntentRepository(database);
      const first = await repository.createPending({
        kind: IntentKind.ContainerUpdate,
        resourceType: IntentResourceType.Container,
        resourceId,
        serverId,
        targetGeneration: 1,
        request: { safe: true },
      });
      await repository.settleForObservedGeneration(
        IntentResourceType.Container,
        resourceId,
        1,
        {
          outcome: 'failed',
          placementServerId: serverId,
          failure: {
            code: 'INSTANCE_BUSY',
            message: 'Retryable busy state',
            details: {},
          },
        },
      );
      const retried = await repository.createRetry({
        sourceIntentId: first.id,
        kind: IntentKind.ContainerUpdate,
        resourceType: IntentResourceType.Container,
        resourceId,
        serverId,
        targetGeneration: 2,
        request: { safe: true },
      });
      expect(retried.id).not.toBe(first.id);
      const latest = await repository.createPending({
        kind: IntentKind.ContainerUpdate,
        resourceType: IntentResourceType.Container,
        resourceId,
        serverId,
        targetGeneration: 3,
        request: { safe: true },
      });
      expect(latest.id).not.toBe(retried.id);

      const page = await repository.listForResource(
        IntentResourceType.Container,
        resourceId,
        { limit: 1 },
      );
      expect(page.items).toHaveLength(1);
      expect(page.nextCursor).not.toBeNull();
      const nextPage = await repository.listForResource(
        IntentResourceType.Container,
        resourceId,
        { limit: 1, cursor: page.nextCursor! },
      );
      expect(nextPage.items).toHaveLength(1);

      const result = await repository.settleForObservedGeneration(
        IntentResourceType.Container,
        resourceId,
        3,
        {
          outcome: 'failed',
          placementServerId: serverId,
          failure: {
            code: 'EXTENSION_MUTATION_REQUIRES_STOP',
            message: 'The instance must be stopped',
            details: { bounded: true },
          },
        },
      );
      expect(result.failed).toBe(1);
      expect(result.superseded).toBe(1);

      const rows = await database
        .selectFrom('control.intents')
        .select(['id', 'target_generation', 'status', 'failure_code', 'failure_json'])
        .where('resource_id', '=', resourceId)
        .orderBy('target_generation')
        .execute();
      expect(rows.map((row) => row.status)).toEqual(['failed', 'failed', 'failed']);
      expect(rows[0]?.failure_code).toBe('INSTANCE_BUSY');
      expect(rows[1]?.failure_code).toBe('SUPERSEDED_BY_FAILED_GENERATION');
      expect(rows[2]?.failure_code).toBe('EXTENSION_MUTATION_REQUIRES_STOP');
    });
  });

  it('does not settle restart intents when a later desired-state generation succeeds', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = randomUUID();
      await database.insertInto('infra.servers').values({
        id: serverId,
        name: 'restart-coalesce-server',
        slug: 'restart-coalesce-server',
        api_endpoint: 'https://127.0.0.1:8443',
        parent_interface: null,
        dns_servers: [],
        status: 'unknown',
        api_extensions: [],
        storage_overcommit_ratio: 1,
        system_pool_id: null,
        server_cert_fingerprint: null,
        incus_version: null,
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

      const resourceId = randomUUID();
      const repository = new IntentRepository(database);
      const restart = await repository.createPending({
        kind: IntentKind.ContainerPower,
        resourceType: IntentResourceType.Container,
        resourceId,
        serverId,
        targetGeneration: 1,
        request: { action: 'restart' },
        baseline: { startedAt: '2026-01-01T00:00:00.000Z' },
      });
      await repository.createPending({
        kind: IntentKind.ContainerUpdate,
        resourceType: IntentResourceType.Container,
        resourceId,
        serverId,
        targetGeneration: 2,
        request: { cpu: true },
      });

      const result = await repository.settleForObservedGeneration(
        IntentResourceType.Container,
        resourceId,
        2,
        { outcome: 'succeeded', placementServerId: serverId },
      );
      expect(result.succeeded).toBe(1);
      const rows = await database
        .selectFrom('control.intents')
        .select(['id', 'status'])
        .where('resource_id', '=', resourceId)
        .execute();
      expect(rows.find((row) => row.id === restart.id)?.status).toBe('pending');
      expect(rows.filter((row) => row.status === 'succeeded')).toHaveLength(1);
    });
  });

  it('persists only a trust-token reference for server.connect intents', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = randomUUID();
      await database.insertInto('infra.servers').values({
        id: serverId,
        name: 'connect-test-server',
        slug: 'connect-test-server',
        api_endpoint: 'https://127.0.0.1:8443',
        parent_interface: null,
        dns_servers: [],
        status: 'unknown',
        api_extensions: [],
        storage_overcommit_ratio: 1,
        system_pool_id: null,
        server_cert_fingerprint: null,
        incus_version: null,
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
      const repository = new IntentRepository(database);
      const reference = randomUUID();
      const intent = await repository.createPending({
        kind: IntentKind.ServerConnect,
        resourceType: IntentResourceType.Server,
        resourceId: serverId,
        serverId,
        targetGeneration: 1,
        request: { trustTokenRef: reference },
      });
      const row = await database
        .selectFrom('control.intents')
        .select('request_json')
        .where('id', '=', intent.id)
        .executeTakeFirstOrThrow();
      expect(row.request_json).toEqual({ trustTokenRef: reference });
      await expect(repository.createPending({
        kind: IntentKind.ServerConnect,
        resourceType: IntentResourceType.Server,
        resourceId: serverId,
        serverId,
        targetGeneration: 2,
        request: { trustTokenRef: randomUUID(), trustToken: 'secret' },
      })).rejects.toThrow('cannot persist a trust token');
    });
  });

  it('reuses a settled scan intent without hiding a changed generation or drift key', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = randomUUID();
      await database.insertInto('infra.servers').values({
        id: serverId,
        name: 'idempotency-test-server',
        slug: 'idempotency-test-server',
        api_endpoint: 'https://127.0.0.1:8443',
        parent_interface: null,
        dns_servers: [],
        status: 'unknown',
        api_extensions: [],
        storage_overcommit_ratio: 1,
        system_pool_id: null,
        server_cert_fingerprint: null,
        incus_version: null,
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

      const resourceId = randomUUID();
      const repository = new IntentRepository(database);
      const settled = await repository.ensurePending({
        kind: IntentKind.ContainerUpdate,
        resourceType: IntentResourceType.Container,
        resourceId,
        serverId,
        targetGeneration: 1,
        request: { source: 'full_scan' },
      });
      await repository.settleForObservedGeneration(
        IntentResourceType.Container,
        resourceId,
        1,
        { outcome: 'succeeded', placementServerId: serverId },
      );

      const reused = await repository.ensurePending({
        kind: IntentKind.ContainerUpdate,
        resourceType: IntentResourceType.Container,
        resourceId,
        serverId,
        targetGeneration: 1,
        request: { source: 'full_scan', operation: 'verify' },
      });
      const drift = await repository.ensurePending({
        kind: IntentKind.ContainerUpdate,
        resourceType: IntentResourceType.Container,
        resourceId,
        serverId,
        targetGeneration: 1,
        request: {
          source: 'full_scan',
          idempotencyKey: 'physical:drift',
        },
      });
      const desiredChange = await repository.ensurePending({
        kind: IntentKind.ContainerUpdate,
        resourceType: IntentResourceType.Container,
        resourceId,
        serverId,
        targetGeneration: 2,
        request: { source: 'full_scan' },
      });

      expect(reused.id).toBe(settled.id);
      expect(reused.status).toBe('succeeded');
      expect(drift.id).not.toBe(settled.id);
      expect(drift.status).toBe('pending');
      expect(desiredChange.id).not.toBe(settled.id);
      expect(await database.selectFrom('control.intents')
        .select('id')
        .where('resource_id', '=', resourceId)
        .execute()).toHaveLength(3);
    });
  });

  it('creates a new pending scan when reuseSettled is false after a succeeded generation key', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = randomUUID();
      await database.insertInto('infra.servers').values({
        id: serverId,
        name: 'rescan-test-server',
        slug: 'rescan-test-server',
        api_endpoint: 'https://127.0.0.1:8443',
        parent_interface: null,
        dns_servers: [],
        status: 'unknown',
        api_extensions: [],
        storage_overcommit_ratio: 1,
        system_pool_id: null,
        server_cert_fingerprint: null,
        incus_version: null,
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

      const resourceId = randomUUID();
      const repository = new IntentRepository(database);
      const settled = await repository.ensurePending({
        kind: IntentKind.ContainerUpdate,
        resourceType: IntentResourceType.Container,
        resourceId,
        serverId,
        targetGeneration: 1,
        request: { source: 'full_scan' },
      });
      await repository.settleForObservedGeneration(
        IntentResourceType.Container,
        resourceId,
        1,
        { outcome: 'succeeded', placementServerId: serverId },
      );

      const rescan = await repository.ensurePending({
        kind: IntentKind.ContainerUpdate,
        resourceType: IntentResourceType.Container,
        resourceId,
        serverId,
        targetGeneration: 1,
        reuseSettled: false,
        request: { source: 'full_scan', idempotencyKey: 'physical:scan' },
      });

      expect(rescan.id).not.toBe(settled.id);
      expect(rescan.status).toBe('pending');

      await repository.settleForObservedGeneration(
        IntentResourceType.Container,
        resourceId,
        1,
        { outcome: 'succeeded', placementServerId: serverId },
      );
      const secondScan = await repository.ensurePending({
        kind: IntentKind.ContainerUpdate,
        resourceType: IntentResourceType.Container,
        resourceId,
        serverId,
        targetGeneration: 1,
        reuseSettled: false,
        request: { source: 'full_scan', idempotencyKey: 'physical:scan' },
      });
      expect(secondScan.id).not.toBe(rescan.id);
      expect(secondScan.status).toBe('pending');
    });
  });

  it('does not settle volume intents across placement server_id', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const volumeId = randomUUID();
      const serverA = randomUUID();
      const serverB = randomUUID();
      await database.insertInto('infra.servers').values([
        {
          id: serverA,
          name: 'intent-vol-a',
          slug: 'intent-vol-a',
          api_endpoint: 'https://127.0.0.1:8443',
          parent_interface: null,
          dns_servers: [],
          status: 'unknown',
          api_extensions: [],
          storage_overcommit_ratio: 1,
          system_pool_id: null,
          server_cert_fingerprint: null,
          incus_version: null,
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
        },
        {
          id: serverB,
          name: 'intent-vol-b',
          slug: 'intent-vol-b',
          api_endpoint: 'https://127.0.0.1:8444',
          parent_interface: null,
          dns_servers: [],
          status: 'unknown',
          api_extensions: [],
          storage_overcommit_ratio: 1,
          system_pool_id: null,
          server_cert_fingerprint: null,
          incus_version: null,
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
        },
      ]).execute();
      const repository = new IntentRepository(database);
      const first = await repository.createPending({
        kind: IntentKind.VolumeEnsure,
        resourceType: IntentResourceType.Volume,
        resourceId: volumeId,
        serverId: serverA,
        targetGeneration: 1,
        request: { operation: 'delete', idempotencyKey: 'delete' },
      });
      const second = await repository.createPending({
        kind: IntentKind.VolumeEnsure,
        resourceType: IntentResourceType.Volume,
        resourceId: volumeId,
        serverId: serverB,
        targetGeneration: 1,
        request: { operation: 'delete', idempotencyKey: 'delete' },
      });

      await repository.settleForObservedGeneration(
        IntentResourceType.Volume,
        volumeId,
        1,
        { outcome: 'succeeded', placementServerId: serverA },
      );

      const firstRow = await repository.findById(first.id);
      const secondRow = await repository.findById(second.id);
      expect(firstRow?.status).toBe('succeeded');
      expect(secondRow?.status).toBe('pending');
    });
  });

  it('caps concurrent claims per server and recycles an expired lease', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = randomUUID();
      await database.insertInto('infra.servers').values({
        id: serverId,
        name: 'claim-test-server',
        slug: 'claim-test-server',
        api_endpoint: 'https://127.0.0.1:8443',
        parent_interface: null,
        dns_servers: [],
        status: 'unknown',
        api_extensions: [],
        storage_overcommit_ratio: 1,
        system_pool_id: null,
        server_cert_fingerprint: null,
        incus_version: null,
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

      const repository = new ReconcileClaimRepository(database);
      const claims = await Promise.all(
        Array.from({ length: MAX_ACTIVE_CLAIMS_PER_SERVER + 2 }, (_, index) =>
          repository.claim({
            resourceType: IntentResourceType.Container,
            resourceId: randomUUID(),
            placementServerId: serverId,
            serverId,
            workerId: `worker-${index}`,
          })),
      );
      expect(claims.filter(Boolean)).toHaveLength(MAX_ACTIVE_CLAIMS_PER_SERVER);

      const first = claims.find((claim) => claim !== null)!;
      await sql`
        UPDATE control.reconcile_claims
        SET lease_expires_at = clock_timestamp() - interval '1 second'
        WHERE resource_type = ${first.resourceType}
          AND resource_id = ${first.resourceId}
      `.execute(database);
      expect(await repository.reapExpired()).toBe(1);
      const recycled = await repository.claim({
        resourceType: first.resourceType,
        resourceId: first.resourceId,
        placementServerId: serverId,
        serverId,
        workerId: 'replacement-worker',
      });
      expect(recycled?.workerId).toBe('replacement-worker');
    });
  });

  it('claims two volume placements in parallel and renews only one', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const volumeId = randomUUID();
      const serverA = randomUUID();
      const serverB = randomUUID();
      await database.insertInto('infra.servers').values([
        {
          id: serverA,
          name: 'claim-a',
          slug: 'claim-a',
          api_endpoint: 'https://127.0.0.1:8443',
          parent_interface: null,
          dns_servers: [],
          status: 'unknown',
          api_extensions: [],
          storage_overcommit_ratio: 1,
          system_pool_id: null,
          server_cert_fingerprint: null,
          incus_version: null,
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
        },
        {
          id: serverB,
          name: 'claim-b',
          slug: 'claim-b',
          api_endpoint: 'https://127.0.0.1:8444',
          parent_interface: null,
          dns_servers: [],
          status: 'unknown',
          api_extensions: [],
          storage_overcommit_ratio: 1,
          system_pool_id: null,
          server_cert_fingerprint: null,
          incus_version: null,
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
        },
      ]).execute();
      const repository = new ReconcileClaimRepository(database);
      const [first, second] = await Promise.all([
        repository.claim({
          resourceType: IntentResourceType.Volume,
          resourceId: volumeId,
          placementServerId: serverA,
          serverId: serverA,
          workerId: 'worker-a',
        }),
        repository.claim({
          resourceType: IntentResourceType.Volume,
          resourceId: volumeId,
          placementServerId: serverB,
          serverId: serverB,
          workerId: 'worker-b',
        }),
      ]);
      expect(first?.placementServerId).toBe(serverA);
      expect(second?.placementServerId).toBe(serverB);
      const renewed = await repository.renew({
        resourceType: IntentResourceType.Volume,
        resourceId: volumeId,
        placementServerId: serverA,
        workerId: 'worker-a',
      });
      expect(renewed?.placementServerId).toBe(serverA);
      expect(await repository.release({
        resourceType: IntentResourceType.Volume,
        resourceId: volumeId,
        placementServerId: serverB,
        workerId: 'worker-b',
      })).toBe(true);
      expect(await repository.renew({
        resourceType: IntentResourceType.Volume,
        resourceId: volumeId,
        placementServerId: serverB,
        workerId: 'worker-b',
      })).toBeNull();
    });
  });

  it('makes volume.destroy sentinel claims exclusive with placement claims', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverA = randomUUID();
      const serverB = randomUUID();
      const volumeId = randomUUID();
      await database.insertInto('infra.servers').values([
        {
          id: serverA,
          name: 'destroy-a',
          slug: 'destroy-a',
          api_endpoint: 'https://127.0.0.1:8443',
          parent_interface: null,
          dns_servers: [],
          status: 'unknown',
          api_extensions: [],
          storage_overcommit_ratio: 1,
          system_pool_id: null,
          server_cert_fingerprint: null,
          incus_version: null,
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
        },
        {
          id: serverB,
          name: 'destroy-b',
          slug: 'destroy-b',
          api_endpoint: 'https://127.0.0.1:8444',
          parent_interface: null,
          dns_servers: [],
          status: 'unknown',
          api_extensions: [],
          storage_overcommit_ratio: 1,
          system_pool_id: null,
          server_cert_fingerprint: null,
          incus_version: null,
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
        },
      ]).execute();
      const repository = new ReconcileClaimRepository(database);
      const destroy = await repository.claim({
        resourceType: IntentResourceType.Volume,
        resourceId: volumeId,
        placementServerId: VOLUME_DESTROY_PLACEMENT_ID,
        workerId: 'destroy-worker',
      });
      expect(destroy?.placementServerId).toBe(VOLUME_DESTROY_PLACEMENT_ID);
      expect(await repository.claim({
        resourceType: IntentResourceType.Volume,
        resourceId: volumeId,
        placementServerId: serverA,
        serverId: serverA,
        workerId: 'ensure-a',
      })).toBeNull();

      expect(await repository.release({
        resourceType: IntentResourceType.Volume,
        resourceId: volumeId,
        placementServerId: VOLUME_DESTROY_PLACEMENT_ID,
        workerId: 'destroy-worker',
      })).toBe(true);

      const first = await repository.claim({
        resourceType: IntentResourceType.Volume,
        resourceId: volumeId,
        placementServerId: serverA,
        serverId: serverA,
        workerId: 'ensure-a',
      });
      const second = await repository.claim({
        resourceType: IntentResourceType.Volume,
        resourceId: volumeId,
        placementServerId: serverB,
        serverId: serverB,
        workerId: 'ensure-b',
      });
      expect(first?.placementServerId).toBe(serverA);
      expect(second?.placementServerId).toBe(serverB);
      expect(await repository.claim({
        resourceType: IntentResourceType.Volume,
        resourceId: volumeId,
        placementServerId: VOLUME_DESTROY_PLACEMENT_ID,
        workerId: 'destroy-worker',
      })).toBeNull();
    });
  });
});
