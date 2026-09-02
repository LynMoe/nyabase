import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { withPostgresTestDatabase } from '../persistence-pg/postgres-test-harness.js';
import { ServerPreflightReconciler } from './server-preflight-reconciler.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function serverValues(id: string) {
  return {
    id,
    name: 'pg-connect-node',
    slug: `pg-connect-${id.slice(0, 8)}`,
    api_endpoint: 'https://incus.example.test:8443',
    server_cert_fingerprint: 'aa'.repeat(32),
    incus_version: null,
    api_extensions: [],
    system_pool_id: null,
    storage_overcommit_ratio: 1,
    parent_interface: 'eth0',
    dns_servers: [],
    status: 'unknown' as const,
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

function response() {
  return {
    metadata: {
      environment: {
        server_name: 'pg-connect-node',
        certificate_fingerprint: 'aa'.repeat(32),
        server_version: '6.0',
      },
      api_extensions: ['resources_v2'],
    },
    status: 200,
    envelope: { type: 'sync' },
  };
}

function connect(
  reconciler: ServerPreflightReconciler,
  client: unknown,
  server: unknown,
  reference: string,
): Promise<void> {
  return (
    reconciler as unknown as {
      connectWithTrustToken: (
        client: unknown,
        server: unknown,
        intent: unknown,
        signal: AbortSignal,
      ) => Promise<void>;
    }
  ).connectWithTrustToken(
    client,
    server,
    {
      request: {
        trustTokenRef: reference,
        expectedServerCertFingerprint: 'aa'.repeat(32),
      },
    },
    new AbortController().signal,
  );
}

function reconciler(database: unknown, trustTokens: unknown): ServerPreflightReconciler {
  return new ServerPreflightReconciler(
    database as never,
    {} as never,
    {} as never,
    trustTokens as never,
    { get: vi.fn() } as never,
  );
}

describePg('server connect trust projection', () => {
  it('commits trusted before a delayed read and projects verified online state', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = randomUUID();
      const certificateId = randomUUID();
      await database.insertInto('infra.servers').values(serverValues(serverId)).execute();
      await database
        .insertInto('system.incus_client_certificates')
        .values({
          id: certificateId,
          generation: 1,
          certificate_pem: 'active-certificate',
          encrypted_private_key: 'active-private-key',
          fingerprint: 'bb'.repeat(32),
          not_before: new Date('2026-01-01T00:00:00Z'),
          not_after: new Date('2027-01-01T00:00:00Z'),
          state: 'active',
          created_by: null,
          activated_at: new Date('2026-01-01T00:00:00Z'),
          retired_at: null,
        })
        .execute();
      await database
        .insertInto('system.incus_client_certificate_trusts')
        .values({
          certificate_id: certificateId,
          server_id: serverId,
          state: 'pending',
          last_error: null,
          observed_at: null,
        })
        .execute();

      const trustTokens = {
        claimTrustToken: vi.fn().mockResolvedValue('one-time-secret'),
        consumeClaimedTrustToken: vi.fn().mockResolvedValue(true),
        releaseClaimedTrustToken: vi.fn().mockResolvedValue(true),
      };
      const readStarted = deferred<void>();
      const releaseRead = deferred<void>();
      const clientResponse = response();
      const client = {
        trustClientCertificate: vi.fn().mockResolvedValue(clientResponse),
        getServer: vi.fn(async () => {
          readStarted.resolve(undefined);
          await releaseRead.promise;
          await expect(
            database
              .selectFrom('system.incus_client_certificate_trusts')
              .select('state')
              .where('certificate_id', '=', certificateId)
              .where('server_id', '=', serverId)
              .executeTakeFirstOrThrow(),
          ).resolves.toEqual({ state: 'trusted' });
          return clientResponse;
        }),
      };
      const service = reconciler(database, trustTokens);

      const pending = connect(
        service,
        client,
        {
          id: serverId,
          name: 'pg-connect-node',
          server_cert_fingerprint: 'aa'.repeat(32),
          status: 'unknown',
          revision: 1,
        },
        randomUUID(),
      );
      await readStarted.promise;
      releaseRead.resolve(undefined);
      await pending;

      await expect(
        database
          .selectFrom('system.incus_client_certificate_trusts')
          .select(['state', 'last_error', 'observed_at'])
          .where('certificate_id', '=', certificateId)
          .where('server_id', '=', serverId)
          .executeTakeFirstOrThrow(),
      ).resolves.toMatchObject({
        state: 'verified',
        last_error: null,
        observed_at: expect.any(Date),
      });
      await expect(
        database
          .selectFrom('infra.servers')
          .select(['status', 'last_error'])
          .where('id', '=', serverId)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ status: 'online', last_error: null });
      expect(trustTokens.claimTrustToken).toHaveBeenCalledOnce();
      expect(trustTokens.consumeClaimedTrustToken).toHaveBeenCalledOnce();
      expect(trustTokens.releaseClaimedTrustToken).not.toHaveBeenCalled();
    });
  });

  it('serializes concurrent connects so only the first pending flow uses the token', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = randomUUID();
      const certificateId = randomUUID();
      await database.insertInto('infra.servers').values(serverValues(serverId)).execute();
      await database
        .insertInto('system.incus_client_certificates')
        .values({
          id: certificateId,
          generation: 1,
          certificate_pem: 'active-certificate',
          encrypted_private_key: 'active-private-key',
          fingerprint: 'cc'.repeat(32),
          not_before: new Date('2026-01-01T00:00:00Z'),
          not_after: new Date('2027-01-01T00:00:00Z'),
          state: 'active',
          created_by: null,
          activated_at: new Date('2026-01-01T00:00:00Z'),
          retired_at: null,
        })
        .execute();
      await database
        .insertInto('system.incus_client_certificate_trusts')
        .values({
          certificate_id: certificateId,
          server_id: serverId,
          state: 'pending',
          last_error: null,
          observed_at: null,
        })
        .execute();

      const trustStarted = deferred<void>();
      const releaseTrust = deferred<void>();
      const clientResponse = response();
      const client = {
        trustClientCertificate: vi.fn(async () => {
          trustStarted.resolve(undefined);
          await releaseTrust.promise;
          return clientResponse;
        }),
        getServer: vi.fn().mockResolvedValue(clientResponse),
      };
      const trustTokens = {
        claimTrustToken: vi.fn().mockResolvedValue('one-time-secret'),
        consumeClaimedTrustToken: vi.fn().mockResolvedValue(true),
        releaseClaimedTrustToken: vi.fn().mockResolvedValue(true),
      };
      const service = reconciler(database, trustTokens);
      const first = connect(
        service,
        client,
        {
          id: serverId,
          name: 'pg-connect-node',
          server_cert_fingerprint: 'aa'.repeat(32),
          status: 'unknown',
          revision: 1,
        },
        randomUUID(),
      );
      await trustStarted.promise;

      const second = connect(
        service,
        client,
        {
          id: serverId,
          name: 'pg-connect-node',
          server_cert_fingerprint: 'aa'.repeat(32),
          status: 'unknown',
          revision: 1,
        },
        randomUUID(),
      );
      await new Promise((resolve) => setImmediate(resolve));
      expect(trustTokens.claimTrustToken).toHaveBeenCalledOnce();
      expect(client.trustClientCertificate).toHaveBeenCalledOnce();

      releaseTrust.resolve(undefined);
      await Promise.all([first, second]);
      expect(trustTokens.claimTrustToken).toHaveBeenCalledOnce();
      expect(client.trustClientCertificate).toHaveBeenCalledOnce();
      expect(trustTokens.consumeClaimedTrustToken).toHaveBeenCalledOnce();
      await expect(
        database
          .selectFrom('system.incus_client_certificate_trusts')
          .select('state')
          .where('certificate_id', '=', certificateId)
          .where('server_id', '=', serverId)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ state: 'verified' });
    });
  });
});
