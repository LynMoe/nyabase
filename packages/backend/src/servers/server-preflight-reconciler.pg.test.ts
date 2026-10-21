import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
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

function response(auth: 'trusted' | 'untrusted' = 'trusted') {
  return {
    metadata: {
      auth,
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

/** An Incus server that reports `untrusted` until the trust call completed. */
function incusServer(onTrust?: () => Promise<void>) {
  let trusted = false;
  return {
    trustClientCertificate: vi.fn(async () => {
      await onTrust?.();
      trusted = true;
      return response();
    }),
    getServer: vi.fn(async () => response(trusted ? 'trusted' : 'untrusted')),
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
    { register: vi.fn() } as never,
  );
}

const serverRow = (serverId: string) => ({
  id: serverId,
  name: 'pg-connect-node',
  server_cert_fingerprint: 'aa'.repeat(32),
  status: 'unknown',
  revision: 1,
});

function tokens() {
  return {
    claimTrustToken: vi.fn().mockReturnValue('one-time-secret'),
    consumeClaimedTrustToken: vi.fn().mockReturnValue(true),
    releaseClaimedTrustToken: vi.fn().mockReturnValue(true),
  };
}

describePg('server connect trust', () => {
  it('trusts the client identity with the one-time token and projects online state', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = randomUUID();
      await database.insertInto('infra.servers').values(serverValues(serverId)).execute();
      const trustTokens = tokens();
      const client = incusServer();

      await connect(reconciler(database, trustTokens), client, serverRow(serverId), randomUUID());

      expect(client.trustClientCertificate).toHaveBeenCalledOnce();
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

  it('does not need a token when the server already trusts the client identity', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = randomUUID();
      await database.insertInto('infra.servers').values(serverValues(serverId)).execute();
      const trustTokens = tokens();
      const client = {
        trustClientCertificate: vi.fn(),
        getServer: vi.fn().mockResolvedValue(response('trusted')),
      };

      await connect(reconciler(database, trustTokens), client, serverRow(serverId), randomUUID());

      expect(client.trustClientCertificate).not.toHaveBeenCalled();
      expect(trustTokens.claimTrustToken).not.toHaveBeenCalled();
      await expect(
        database
          .selectFrom('infra.servers')
          .select('status')
          .where('id', '=', serverId)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ status: 'online' });
    });
  });

  it('serializes concurrent connects so only the first flow uses the token', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = randomUUID();
      await database.insertInto('infra.servers').values(serverValues(serverId)).execute();
      const trustStarted = deferred<void>();
      const releaseTrust = deferred<void>();
      const client = incusServer(async () => {
        trustStarted.resolve(undefined);
        await releaseTrust.promise;
      });
      const trustTokens = tokens();
      const service = reconciler(database, trustTokens);
      const first = connect(service, client, serverRow(serverId), randomUUID());
      await trustStarted.promise;

      const second = connect(service, client, serverRow(serverId), randomUUID());
      await new Promise((resolve) => setImmediate(resolve));
      expect(trustTokens.claimTrustToken).toHaveBeenCalledOnce();
      expect(client.trustClientCertificate).toHaveBeenCalledOnce();

      releaseTrust.resolve(undefined);
      await Promise.all([first, second]);
      expect(trustTokens.claimTrustToken).toHaveBeenCalledOnce();
      expect(client.trustClientCertificate).toHaveBeenCalledOnce();
      expect(trustTokens.consumeClaimedTrustToken).toHaveBeenCalledOnce();
    });
  });
});
