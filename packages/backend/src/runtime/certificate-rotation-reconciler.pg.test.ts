import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CertificateRotationReconciler } from './certificate-rotation-reconciler.service.js';
import { withPostgresTestDatabase } from '../persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { ServersService } from '../servers/servers.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function serverValues(
  id: string,
  name: string,
  status: 'online' | 'unreachable' | 'unknown' = 'unknown',
) {
  return {
    id,
    name,
    slug: name.toLowerCase().replaceAll(' ', '-'),
    api_endpoint: 'https://incus.example.test:8443',
    server_cert_fingerprint: 'ab'.repeat(32),
    incus_version: null,
    api_extensions: [],
    system_pool_id: null,
    storage_overcommit_ratio: 1,
    parent_interface: 'eth0',
    dns_servers: [],
    gpu_runtime_available: false,
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

function certificateValues(
  id: string,
  generation: number,
  state: 'active' | 'staged',
  fingerprint: string,
  now: Date,
) {
  return {
    id,
    generation,
    certificate_pem: `${state}-certificate`,
    encrypted_private_key: `${state}-private-key`,
    fingerprint,
    not_before: now,
    not_after: new Date('2027-01-01T00:00:00Z'),
    state,
    created_by: null,
    activated_at: state === 'active' ? now : null,
    retired_at: null,
  };
}

describePg('certificate rotation server admission serialization', () => {
  it('does not hold lockServerOnboarding while trusting the candidate over Incus HTTP', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const existingServerId = randomUUID();
      const joiningServerName = `joining-${randomUUID().slice(0, 8)}`;
      const activeId = randomUUID();
      const candidateId = randomUUID();
      const now = new Date('2026-01-01T00:00:00Z');

      await database
        .insertInto('infra.servers')
        .values(serverValues(existingServerId, 'existing-node', 'online'))
        .execute();
      await database
        .insertInto('system.incus_client_certificates')
        .values([
          certificateValues(activeId, 1, 'active', '11'.repeat(32), now),
          certificateValues(candidateId, 2, 'staged', '22'.repeat(32), now),
        ])
        .execute();
      await database
        .insertInto('system.incus_client_certificate_trusts')
        .values({
          certificate_id: candidateId,
          server_id: existingServerId,
          state: 'pending',
          last_error: null,
          observed_at: null,
        })
        .execute();

      const trustStarted = deferred();
      const releaseTrust = deferred();
      const events: string[] = [];
      const activeClient = {
        trustCertificate: vi.fn().mockImplementation(async () => {
          trustStarted.resolve();
          await releaseTrust.promise;
          return {
            status: 200,
            envelope: { type: 'sync' },
          };
        }),
        deleteClientCertificate: vi.fn().mockResolvedValue({ status: 404 }),
      };
      const candidateClient = {
        getServer: vi.fn().mockResolvedValue({ status: 200 }),
      };
      const clients = {
        get: vi.fn().mockResolvedValue(activeClient),
        getForCertificate: vi.fn().mockResolvedValue(candidateClient),
        invalidate: vi.fn(),
      };
      const reconciler = new CertificateRotationReconciler(database, clients as never);
      const rotationPromise = reconciler
        .reconcile({
          intent: {
            id: randomUUID(),
            kind: 'certificate.rotate',
            resourceType: 'certificate_rotation',
            resourceId: randomUUID(),
            serverId: null,
            targetGeneration: 2,
          } as never,
          claim: {} as never,
          lease: {} as never,
          signal: new AbortController().signal,
        })
        .then((result) => {
          events.push('rotation-finished');
          return result;
        });

      await trustStarted.promise;

      const access = {
        assertActorCapabilitiesInTransaction: vi.fn(async () => undefined),
      };
      const serverService = new ServersService(
        database,
        new PgTransactionManager(database),
        access as never,
        { append: vi.fn().mockResolvedValue(undefined) } as never,
      );
      const created = await serverService.create('actor-1', {
        name: joiningServerName,
        slug: joiningServerName,
        apiEndpoint: 'https://joining.example.test:8443',
        parentInterface: 'eth0',
        dnsServers: [],
      });
      events.push('server-created');
      expect(created.slug).toBe(joiningServerName);

      releaseTrust.resolve();
      const rotation = await rotationPromise;
      expect(rotation).toMatchObject({
        outcome: 'succeeded',
        observedGeneration: 2,
      });
      expect(events).toEqual(['server-created', 'rotation-finished']);
      expect(activeClient.deleteClientCertificate).toHaveBeenCalledWith('11'.repeat(32));

      const certificates = await database
        .selectFrom('system.incus_client_certificates')
        .select(['generation', 'state'])
        .orderBy('generation')
        .execute();
      expect(certificates).toEqual([
        { generation: '1', state: 'retired' },
        { generation: '2', state: 'active' },
      ]);
    });
  });

  it('keeps the old certificate active when online candidate verification needs a retry', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = randomUUID();
      const activeId = randomUUID();
      const candidateId = randomUUID();
      const now = new Date('2026-01-01T00:00:00Z');

      await database
        .insertInto('infra.servers')
        .values(serverValues(serverId, 'retry-node', 'online'))
        .execute();
      await database
        .insertInto('system.incus_client_certificates')
        .values([
          certificateValues(activeId, 1, 'active', '33'.repeat(32), now),
          certificateValues(candidateId, 2, 'staged', '44'.repeat(32), now),
        ])
        .execute();
      await database
        .insertInto('system.incus_client_certificate_trusts')
        .values({
          certificate_id: candidateId,
          server_id: serverId,
          state: 'pending',
          last_error: null,
          observed_at: null,
        })
        .execute();

      const clients = {
        get: vi.fn().mockResolvedValue({
          trustCertificate: vi.fn().mockResolvedValue({
            status: 200,
            envelope: { type: 'sync' },
          }),
        }),
        getForCertificate: vi.fn().mockResolvedValue({
          getServer: vi.fn().mockRejectedValue(new Error('candidate not ready')),
        }),
      };
      const reconciler = new CertificateRotationReconciler(database, clients as never);

      await expect(
        reconciler.reconcile({
          intent: {
            id: randomUUID(),
            kind: 'certificate.rotate',
            resourceType: 'certificate_rotation',
            resourceId: randomUUID(),
            serverId: null,
            targetGeneration: 2,
          } as never,
          claim: {} as never,
          lease: {} as never,
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({
        outcome: 'retry',
        failure: {
          code: 'CERTIFICATE_ROTATION_TRUST_PENDING',
        },
      });

      await expect(
        database
          .selectFrom('system.incus_client_certificates')
          .select(['generation', 'state'])
          .orderBy('generation')
          .execute(),
      ).resolves.toEqual([
        { generation: '1', state: 'active' },
        { generation: '2', state: 'staged' },
      ]);
      await expect(
        database
          .selectFrom('system.incus_client_certificate_trusts')
          .select(['state', 'last_error'])
          .where('certificate_id', '=', candidateId)
          .where('server_id', '=', serverId)
          .executeTakeFirst(),
      ).resolves.toEqual({
        state: 'pending',
        last_error: '[attempts=1] candidate not ready',
      });
    });
  });

  it('activates when the online server is verified even if a never-online server is pending', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const onlineId = randomUUID();
      const unknownId = randomUUID();
      const activeId = randomUUID();
      const candidateId = randomUUID();
      const now = new Date('2026-01-01T00:00:00Z');

      await database
        .insertInto('infra.servers')
        .values([
          serverValues(onlineId, 'online-node', 'online'),
          serverValues(unknownId, 'never-online-node', 'unknown'),
        ])
        .execute();
      await database
        .insertInto('system.incus_client_certificates')
        .values([
          certificateValues(activeId, 1, 'active', '55'.repeat(32), now),
          certificateValues(candidateId, 2, 'staged', '66'.repeat(32), now),
        ])
        .execute();
      await database
        .insertInto('system.incus_client_certificate_trusts')
        .values([
          {
            certificate_id: candidateId,
            server_id: onlineId,
            state: 'pending',
            last_error: null,
            observed_at: null,
          },
          {
            certificate_id: candidateId,
            server_id: unknownId,
            state: 'pending',
            last_error: null,
            observed_at: null,
          },
        ])
        .execute();

      const clients = {
        get: vi.fn().mockResolvedValue({
          trustCertificate: vi.fn().mockResolvedValue({
            status: 200,
            envelope: { type: 'sync' },
          }),
          deleteClientCertificate: vi.fn().mockResolvedValue({ status: 404 }),
        }),
        getForCertificate: vi.fn().mockImplementation(async (serverId: string) => {
          expect(serverId).toBe(onlineId);
          return { getServer: vi.fn().mockResolvedValue({ status: 200 }) };
        }),
        invalidate: vi.fn(),
      };
      const reconciler = new CertificateRotationReconciler(database, clients as never);

      await expect(
        reconciler.reconcile({
          intent: {
            id: randomUUID(),
            kind: 'certificate.rotate',
            resourceType: 'certificate_rotation',
            resourceId: randomUUID(),
            serverId: null,
            targetGeneration: 2,
          } as never,
          claim: {} as never,
          lease: {} as never,
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({
        outcome: 'succeeded',
        observedGeneration: 2,
      });

      await expect(
        database
          .selectFrom('system.incus_client_certificates')
          .select(['generation', 'state'])
          .orderBy('generation')
          .execute(),
      ).resolves.toEqual([
        { generation: '1', state: 'retired' },
        { generation: '2', state: 'active' },
      ]);
      const unknownTrust = await database
        .selectFrom('system.incus_client_certificate_trusts')
        .select(['state', 'last_error'])
        .where('certificate_id', '=', candidateId)
        .where('server_id', '=', unknownId)
        .executeTakeFirst();
      expect(unknownTrust?.state).toBe('pending');
      expect(unknownTrust?.last_error).toMatch(/needs_attention/);
      const oldTrust = await database
        .selectFrom('system.incus_client_certificate_trusts')
        .select(['state'])
        .where('certificate_id', '=', activeId)
        .where('server_id', '=', onlineId)
        .executeTakeFirst();
      expect(oldTrust?.state).toBe('revoked');
    });
  });
});
