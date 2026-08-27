import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { deriveInstanceHwaddr, IncusError } from '../incus/index.js';
import { ServerPreflightReconciler } from './server-preflight-reconciler.service.js';

const serverId = '00000000-0000-4000-8000-000000000001';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function database(
  selectResult?: unknown,
  trustState: 'pending' | 'trusted' | 'verified' | null = 'pending',
) {
  const updates: Array<Record<string, unknown>> = [];
  const trustWrites: Array<Record<string, unknown>> = [];
  let currentTrustState = trustState;
  const builder = (table: string) => {
    const query: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const method of ['select', 'selectAll', 'where', 'forUpdate', 'orderBy', 'innerJoin']) {
      query[method] = vi.fn(() => query);
    }
    query.executeTakeFirst = vi
      .fn()
      .mockResolvedValue(
        table === 'system.incus_client_certificates'
          ? { id: '00000000-0000-4000-8000-000000000010' }
          : table === 'system.incus_client_certificate_trusts'
            ? currentTrustState === null
              ? undefined
              : { state: currentTrustState }
            : String(table).includes('ip_pool')
              ? { gateway: '169.254.0.1', cidr: '169.254.0.0/24' }
              : selectResult,
      );
    query.execute = vi.fn().mockResolvedValue([]);
    return query;
  };
  const database: {
    [key: string]: unknown;
    updates: Array<Record<string, unknown>>;
  } = {
    updateTable: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        updates.push(values);
        return {
          where: vi.fn(() => ({
            execute: vi.fn().mockResolvedValue(undefined),
          })),
        };
      }),
    })),
    selectFrom: vi.fn((table: string) => builder(table)),
    insertInto: vi.fn(() => {
      const query: Record<string, ReturnType<typeof vi.fn>> = {};
      query.values = vi.fn((values: Record<string, unknown>) => {
        trustWrites.push(values);
        currentTrustState = values.state as typeof currentTrustState;
        return query;
      });
      query.onConflict = vi.fn(() => query);
      query.execute = vi.fn().mockResolvedValue(undefined);
      return query;
    }),
    updates,
    trustWrites,
    setTrustState: (state: typeof trustState) => {
      currentTrustState = state;
    },
  };
  const transaction = {
    ...database,
    getExecutor: vi.fn(() => ({
      transformQuery: vi.fn((query: unknown) => query),
      compileQuery: vi.fn((query: unknown) => query),
      executeQuery: vi.fn().mockResolvedValue({ rows: [] }),
    })),
  };
  database.transaction = vi.fn(() => ({
    execute: vi.fn(async (callback: (executor: typeof transaction) => Promise<unknown>) =>
      callback(transaction),
    ),
  }));
  return database;
}

function server() {
  return {
    id: serverId,
    name: 'test-server',
    parent_interface: 'eth0',
    server_cert_fingerprint: null,
    node_metrics_endpoint: null,
    node_metrics_token_ciphertext: null,
    status: 'unknown',
    system_pool_id: null,
    preflight_status: 'not_run',
    revision: 1,
  };
}

function reconciler(
  db: ReturnType<typeof database>,
  trustTokens = {
    storeTrustToken: vi.fn().mockResolvedValue('reference'),
    claimTrustToken: vi.fn().mockResolvedValue('one-time-secret'),
    consumeClaimedTrustToken: vi.fn().mockResolvedValue(true),
    releaseClaimedTrustToken: vi.fn().mockResolvedValue(true),
  },
) {
  return new ServerPreflightReconciler(
    db as never,
    {
      pull: vi.fn(),
    } as never,
    {
      checkNetworkPrerequisites: vi.fn(),
      checkGpuToolkit: vi.fn(),
      checkEgress: vi.fn(),
    } as never,
    trustTokens,
    {
      get: vi.fn(
        (key: string) =>
          ({
            'incus.preflightImageAlias': 'ubuntu/24.04',
            'incus.preflightImageFingerprint': '',
            'incus.preflightSourceServer': 'https://images.linuxcontainers.org',
          })[key],
      ),
    } as never,
  );
}

function revisionRaceDatabase() {
  let updateCount = 0;
  const serverRow = server();
  const selectBuilder: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ['select', 'where']) {
    selectBuilder[method] = vi.fn(() => selectBuilder);
  }
  selectBuilder.executeTakeFirst = vi.fn().mockResolvedValue(serverRow);
  return {
    selectFrom: vi.fn(() => selectBuilder),
    updateTable: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          execute: vi.fn(async () => {
            updateCount += 1;
            return [{ numUpdatedRows: updateCount === 1 ? 1n : 0n }];
          }),
        })),
      })),
    })),
  };
}

describe('ServerPreflightReconciler', () => {
  it('consumes a Redis reference and sends the secret only to Incus trust setup', async () => {
    const db = database();
    const trustTokens = {
      storeTrustToken: vi.fn().mockResolvedValue('reference'),
      claimTrustToken: vi.fn().mockResolvedValue('one-time-secret'),
      consumeClaimedTrustToken: vi.fn().mockResolvedValue(true),
      releaseClaimedTrustToken: vi.fn().mockResolvedValue(true),
    };
    const instance = reconciler(db, trustTokens);
    const client = {
      trustClientCertificate: vi.fn().mockResolvedValue({
        status: 201,
        envelope: {
          type: 'sync',
          status: 'Success',
          status_code: 200,
          operation: '',
          error_code: 0,
          error: '',
          metadata: null,
        },
        metadata: null,
      }),
      getOperationWait: vi.fn(),
      getServer: vi.fn().mockResolvedValue({
        metadata: {
          environment: {
            server_name: 'test-server',
            certificate_fingerprint: 'aa'.repeat(32),
            server_version: '6.0',
          },
          api_extensions: ['resources_v2'],
        },
        status: 200,
        envelope: { type: 'sync' },
      }),
    };
    const intent = {
      request: {
        trustTokenRef: '00000000-0000-4000-8000-000000000002',
      },
    } as never;

    await (
      instance as unknown as {
        connectWithTrustToken: (
          client: unknown,
          server: unknown,
          intent: unknown,
          signal: AbortSignal,
        ) => Promise<void>;
      }
    ).connectWithTrustToken(client, server(), intent, new AbortController().signal);

    expect(trustTokens.claimTrustToken).toHaveBeenCalledWith(
      serverId,
      '00000000-0000-4000-8000-000000000002',
      expect.any(String),
    );
    expect(trustTokens.consumeClaimedTrustToken).toHaveBeenCalledWith(
      serverId,
      '00000000-0000-4000-8000-000000000002',
      expect.any(String),
    );
    expect(client.trustClientCertificate).toHaveBeenCalledWith(
      'one-time-secret',
      `nyabase-${serverId.replaceAll('-', '')}`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(client.getOperationWait).not.toHaveBeenCalled();
  });

  it('does not invoke Incus HTTP while the onboarding lock transaction is open', async () => {
    const db = database();
    let openTransactions = 0;
    const originalTransaction = db.transaction as () => {
      execute: (callback: (executor: unknown) => Promise<unknown>) => Promise<unknown>;
    };
    db.transaction = vi.fn(() => ({
      execute: vi.fn(async (callback: (executor: unknown) => Promise<unknown>) => {
        openTransactions += 1;
        try {
          return await originalTransaction().execute(callback);
        } finally {
          openTransactions -= 1;
        }
      }),
    }));
    const trustTokens = {
      storeTrustToken: vi.fn().mockResolvedValue('reference'),
      claimTrustToken: vi.fn().mockResolvedValue('one-time-secret'),
      consumeClaimedTrustToken: vi.fn().mockResolvedValue(true),
      releaseClaimedTrustToken: vi.fn().mockResolvedValue(true),
    };
    const instance = reconciler(db, trustTokens);
    const response = {
      metadata: {
        environment: {
          server_name: 'test-server',
          certificate_fingerprint: 'aa'.repeat(32),
          server_version: '6.0',
        },
        api_extensions: [],
      },
      status: 200,
      envelope: { type: 'sync' },
    };
    const txnOpenDuringHttp: boolean[] = [];
    const client = {
      trustClientCertificate: vi.fn(async () => {
        txnOpenDuringHttp.push(openTransactions > 0);
        return {
          status: 201,
          envelope: { type: 'sync', status_code: 200 },
          metadata: null,
        };
      }),
      getServer: vi.fn(async () => {
        txnOpenDuringHttp.push(openTransactions > 0);
        return response;
      }),
    };

    await (
      instance as unknown as {
        connectWithTrustToken: (
          client: unknown,
          server: unknown,
          intent: unknown,
          signal: AbortSignal,
        ) => Promise<void>;
      }
    ).connectWithTrustToken(
      client,
      server(),
      {
        request: {
          trustTokenRef: '00000000-0000-4000-8000-000000000002',
        },
      } as never,
      new AbortController().signal,
    );

    expect(txnOpenDuringHttp.length).toBeGreaterThan(0);
    expect(txnOpenDuringHttp.every((open) => open === false)).toBe(true);
    expect(db.transaction).toHaveBeenCalled();
  });

  it('persists trusted before a delayed read and verifies after the read succeeds', async () => {
    const fixture = database();
    const trustTokens = {
      storeTrustToken: vi.fn(),
      claimTrustToken: vi.fn().mockResolvedValue('one-time-secret'),
      consumeClaimedTrustToken: vi.fn().mockResolvedValue(true),
      releaseClaimedTrustToken: vi.fn().mockResolvedValue(true),
    };
    const instance = reconciler(fixture, trustTokens);
    const response = {
      metadata: {
        environment: {
          server_name: 'test-server',
          certificate_fingerprint: 'aa'.repeat(32),
          server_version: '6.0',
        },
        api_extensions: [],
      },
      status: 200,
      envelope: { type: 'sync' },
    };
    const readStarted = deferred<void>();
    const releaseRead = deferred<void>();
    const client = {
      trustClientCertificate: vi.fn().mockResolvedValue(response),
      getServer: vi
        .fn()
        .mockRejectedValueOnce(new IncusError('TLS_ERROR', 'retry'))
        .mockImplementation(async () => {
          readStarted.resolve(undefined);
          await releaseRead.promise;
          return response;
        }),
    };
    const trustWrites = fixture.trustWrites as Array<Record<string, unknown>>;
    const connectWithTrustToken = (
      instance as unknown as {
        connectWithTrustToken: (
          client: unknown,
          server: unknown,
          intent: unknown,
          signal: AbortSignal,
        ) => Promise<void>;
      }
    ).connectWithTrustToken;

    const pending = connectWithTrustToken.call(
      instance,
      client,
      server(),
      {
        request: {
          trustTokenRef: '00000000-0000-4000-8000-000000000002',
        },
      } as never,
      new AbortController().signal,
    );
    await readStarted.promise;
    expect(trustWrites[0]).toMatchObject({ state: 'trusted' });
    expect(trustTokens.consumeClaimedTrustToken).toHaveBeenCalledOnce();
    releaseRead.resolve(undefined);
    await pending;

    expect(trustWrites.map((write) => write.state)).toEqual(['trusted', 'verified']);
    expect(fixture.updates).toContainEqual(expect.objectContaining({ status: 'online' }));
    expect(trustTokens.releaseClaimedTrustToken).not.toHaveBeenCalled();
  });

  it('persists trusted after a completed asynchronous trust operation', async () => {
    const fixture = database();
    const trustTokens = {
      storeTrustToken: vi.fn(),
      claimTrustToken: vi.fn().mockResolvedValue('one-time-secret'),
      consumeClaimedTrustToken: vi.fn().mockResolvedValue(true),
      releaseClaimedTrustToken: vi.fn().mockResolvedValue(true),
    };
    const instance = reconciler(fixture, trustTokens);
    const response = {
      metadata: null,
      status: 202,
      envelope: {
        type: 'async',
        operation: '/1.0/operations/trust-operation',
      },
    };
    const serverResponse = {
      metadata: {
        environment: {
          server_name: 'test-server',
          certificate_fingerprint: 'aa'.repeat(32),
        },
        api_extensions: [],
      },
      status: 200,
      envelope: { type: 'sync' },
    };
    const client = {
      trustClientCertificate: vi.fn().mockResolvedValue(response),
      getOperationWait: vi.fn().mockResolvedValue({
        metadata: { status: 'Success' },
        status: 200,
        envelope: { type: 'sync' },
      }),
      getServer: vi.fn().mockResolvedValue(serverResponse),
    };

    await (
      instance as unknown as {
        connectWithTrustToken: (
          client: unknown,
          server: unknown,
          intent: unknown,
          signal: AbortSignal,
        ) => Promise<void>;
      }
    ).connectWithTrustToken(
      client,
      server(),
      {
        request: {
          trustTokenRef: '00000000-0000-4000-8000-000000000002',
        },
      } as never,
      new AbortController().signal,
    );

    expect(client.getOperationWait).toHaveBeenCalledOnce();
    expect(fixture.trustWrites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: 'trusted' }),
        expect.objectContaining({ state: 'verified' }),
      ]),
    );
  });

  it('skips the token after a trusted side effect when the first read fails', async () => {
    const fixture = database();
    const firstAttempt = new AbortController();
    const trustTokens = {
      storeTrustToken: vi.fn(),
      claimTrustToken: vi.fn().mockResolvedValue('one-time-secret'),
      consumeClaimedTrustToken: vi.fn().mockResolvedValue(true),
      releaseClaimedTrustToken: vi.fn().mockResolvedValue(true),
    };
    const instance = reconciler(fixture, trustTokens);
    const response = {
      metadata: {
        environment: {
          server_name: 'test-server',
          certificate_fingerprint: 'aa'.repeat(32),
        },
        api_extensions: [],
      },
      status: 200,
      envelope: { type: 'sync' },
    };
    const getServer = vi
      .fn()
      .mockImplementationOnce(async () => {
        firstAttempt.abort();
        throw new IncusError('TLS_ERROR', 'retry');
      })
      .mockResolvedValue(response);
    const client = {
      trustClientCertificate: vi.fn().mockResolvedValue(response),
      getServer,
    };
    const connectWithTrustToken = (
      instance as unknown as {
        connectWithTrustToken: (
          client: unknown,
          server: unknown,
          intent: unknown,
          signal: AbortSignal,
        ) => Promise<void>;
      }
    ).connectWithTrustToken;

    await expect(
      connectWithTrustToken.call(
        instance,
        client,
        server(),
        {
          request: {
            trustTokenRef: '00000000-0000-4000-8000-000000000002',
          },
        } as never,
        firstAttempt.signal,
      ),
    ).rejects.toMatchObject({ code: 'INCUS_TIMEOUT' });
    expect(trustTokens.releaseClaimedTrustToken).not.toHaveBeenCalled();

    await connectWithTrustToken.call(
      instance,
      client,
      server(),
      { request: {} } as never,
      new AbortController().signal,
    );

    expect(trustTokens.claimTrustToken).toHaveBeenCalledOnce();
    expect(client.trustClientCertificate).toHaveBeenCalledOnce();
    expect(trustTokens.consumeClaimedTrustToken).toHaveBeenCalledOnce();
    expect(trustTokens.releaseClaimedTrustToken).not.toHaveBeenCalled();
  });

  it('claims and records trust when the active certificate row is absent', async () => {
    const fixture = database(undefined, null);
    const trustTokens = {
      storeTrustToken: vi.fn(),
      claimTrustToken: vi.fn().mockResolvedValue('one-time-secret'),
      consumeClaimedTrustToken: vi.fn().mockResolvedValue(true),
      releaseClaimedTrustToken: vi.fn().mockResolvedValue(true),
    };
    const instance = reconciler(fixture, trustTokens);
    const response = {
      metadata: {
        environment: {
          server_name: 'test-server',
          certificate_fingerprint: 'aa'.repeat(32),
        },
        api_extensions: [],
      },
      status: 200,
      envelope: { type: 'sync' },
    };
    const client = {
      trustClientCertificate: vi.fn().mockResolvedValue(response),
      getServer: vi.fn().mockResolvedValue(response),
    };
    await (
      instance as unknown as {
        connectWithTrustToken: (
          client: unknown,
          server: unknown,
          intent: unknown,
          signal: AbortSignal,
        ) => Promise<void>;
      }
    ).connectWithTrustToken(
      client,
      server(),
      {
        request: {
          trustTokenRef: '00000000-0000-4000-8000-000000000002',
        },
      } as never,
      new AbortController().signal,
    );

    expect(trustTokens.claimTrustToken).toHaveBeenCalledOnce();
    expect(client.trustClientCertificate).toHaveBeenCalledOnce();
    expect(fixture.trustWrites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: 'trusted' }),
        expect.objectContaining({ state: 'verified' }),
      ]),
    );
  });

  it('keeps concurrent connect intents isolated by fingerprint and trust token', async () => {
    const db = database();
    const trustTokens = {
      storeTrustToken: vi.fn(),
      claimTrustToken: vi.fn(async (_server: string, reference: string) =>
        reference.endsWith('002') ? 'token-two' : 'token-one',
      ),
      consumeClaimedTrustToken: vi.fn().mockResolvedValue(true),
      releaseClaimedTrustToken: vi.fn().mockResolvedValue(true),
    };
    const instance = reconciler(db, trustTokens);
    const response = {
      metadata: {
        environment: {
          server_name: 'test-server',
          certificate_fingerprint: 'aa'.repeat(32),
        },
        api_extensions: [],
      },
      status: 200,
      envelope: { type: 'sync' },
    };
    const firstClient = {
      trustClientCertificate: vi.fn().mockResolvedValue(response),
      getServer: vi.fn().mockResolvedValue(response),
    };
    const secondClient = {
      trustClientCertificate: vi.fn().mockResolvedValue(response),
      getServer: vi.fn().mockResolvedValue(response),
    };
    const connectWithTrustToken = (
      instance as unknown as {
        connectWithTrustToken: (
          client: unknown,
          server: unknown,
          intent: unknown,
          signal: AbortSignal,
        ) => Promise<void>;
      }
    ).connectWithTrustToken;
    const connect = (client: unknown, intent: unknown) =>
      connectWithTrustToken.call(instance, client, server(), intent, new AbortController().signal);

    await Promise.all([
      connect(firstClient, {
        request: {
          trustTokenRef: '00000000-0000-4000-8000-000000000001',
          expectedServerCertFingerprint: 'aa'.repeat(32),
        },
      } as never),
      connect(secondClient, {
        request: {
          trustTokenRef: '00000000-0000-4000-8000-000000000002',
          expectedServerCertFingerprint: 'aa'.repeat(32),
        },
      } as never),
    ]);

    expect(trustTokens.claimTrustToken).toHaveBeenCalledWith(
      serverId,
      '00000000-0000-4000-8000-000000000001',
      expect.any(String),
    );
    expect(trustTokens.claimTrustToken).toHaveBeenCalledWith(
      serverId,
      '00000000-0000-4000-8000-000000000002',
      expect.any(String),
    );
    expect(firstClient.trustClientCertificate).toHaveBeenCalledWith(
      'token-one',
      expect.any(String),
      expect.anything(),
    );
    expect(secondClient.trustClientCertificate).toHaveBeenCalledWith(
      'token-two',
      expect.any(String),
      expect.anything(),
    );
  });

  it('releases a claimed trust token when the Incus side effect is retryable', async () => {
    const db = database();
    const trustTokens = {
      storeTrustToken: vi.fn().mockResolvedValue('reference'),
      claimTrustToken: vi.fn().mockResolvedValue('one-time-secret'),
      consumeClaimedTrustToken: vi.fn().mockResolvedValue(true),
      releaseClaimedTrustToken: vi.fn().mockResolvedValue(true),
    };
    const instance = reconciler(db, trustTokens);
    const client = {
      trustClientCertificate: vi
        .fn()
        .mockRejectedValue(new IncusError('SERVER_UNREACHABLE', 'retry')),
      getServer: vi.fn(),
    };

    await expect(
      (
        instance as unknown as {
          connectWithTrustToken: (
            client: unknown,
            server: unknown,
            intent: unknown,
            signal: AbortSignal,
          ) => Promise<void>;
        }
      ).connectWithTrustToken(
        client,
        server(),
        {
          request: {
            trustTokenRef: '00000000-0000-4000-8000-000000000002',
          },
        } as never,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'SERVER_UNREACHABLE' });

    expect(trustTokens.consumeClaimedTrustToken).not.toHaveBeenCalled();
    expect(trustTokens.releaseClaimedTrustToken).toHaveBeenCalledWith(
      serverId,
      '00000000-0000-4000-8000-000000000002',
      expect.any(String),
    );
    expect(client.getServer).not.toHaveBeenCalled();
  });

  it('cleans up a stale managed probe after stopping it and verifies absence', async () => {
    const db = database();
    const getInstanceFull = vi
      .fn()
      .mockResolvedValueOnce({
        metadata: {
          config: {
            'user.nyabase.preflight': 'true',
            'user.nyabase.server_id': serverId.replaceAll('-', ''),
          },
          state: { status: 'Running' },
        },
      })
      .mockRejectedValue(new IncusError('INCUS_NOT_FOUND', 'managed_failure', {}));
    const getInstanceState = vi
      .fn()
      .mockResolvedValueOnce({
        metadata: { status: 'Running' },
      })
      .mockResolvedValue({
        metadata: { status: 'Stopped' },
      });
    const updateInstanceState = vi.fn().mockResolvedValue({
      status: 200,
      envelope: { type: 'sync', status_code: 200 },
    });
    const deleteInstance = vi.fn().mockResolvedValue({
      status: 200,
      envelope: { type: 'sync' },
    });
    const client = {
      getInstanceFull,
      getInstanceState,
      updateInstanceState,
      deleteInstance,
    };
    const instance = reconciler(db);

    await (
      instance as unknown as {
        cleanupStaleProbe: (
          client: unknown,
          probeName: string,
          serverId: string,
          signal: AbortSignal,
        ) => Promise<void>;
      }
    ).cleanupStaleProbe(client, 'nyabase-preflight-test', serverId, new AbortController().signal);

    expect(updateInstanceState).toHaveBeenCalledWith(
      'nyabase-preflight-test',
      { action: 'stop', force: true },
      expect.anything(),
    );
    expect(deleteInstance).toHaveBeenCalledOnce();
    expect(getInstanceFull).toHaveBeenCalledTimes(2);
  });

  it('confirms the probe after an operation-wait 404 and cleans it up', async () => {
    const db = database({
      incus_name: 'default',
      server_id: serverId,
      registered: true,
    });
    const instance = reconciler(db);
    const internals = instance as unknown as {
      connect: ReturnType<typeof vi.fn>;
      checks: {
        checkNetworkPrerequisites: ReturnType<typeof vi.fn>;
        checkGpuToolkit: ReturnType<typeof vi.fn>;
        checkEgress: ReturnType<typeof vi.fn>;
      };
      nodeMetrics: {
        pull: ReturnType<typeof vi.fn>;
      };
    };
    internals.connect = vi.fn().mockResolvedValue({
      metadata: {
        environment: { firewall: 'nftables' },
      },
    });
    internals.checks.checkNetworkPrerequisites.mockResolvedValue({
      forwarding: true,
      rpFilter: true,
      networkPrerequisites: true,
    });
    internals.checks.checkGpuToolkit.mockResolvedValue({ gpuRuntime: 'not_applicable' });
    internals.checks.checkEgress.mockResolvedValue({ status: 'pass' });
    internals.nodeMetrics.pull.mockResolvedValue({
      status: 'online',
      report: { samples: [] },
    });

    const probeName = `nyabase-preflight-${serverId.replaceAll('-', '')}`;
    const probeHwaddr = deriveInstanceHwaddr(
      createHash('sha256')
        .update(`nyabase-preflight:${serverId.replaceAll('-', '').toLowerCase()}`, 'utf8')
        .digest('hex')
        .slice(0, 32),
    );
    const probe = {
      config: {
        'user.nyabase.preflight': 'true',
        'user.nyabase.server_id': serverId.replaceAll('-', ''),
      },
      state: { status: 'Running' },
    };
    const getInstanceFull = vi
      .fn()
      .mockRejectedValueOnce(new IncusError('INCUS_NOT_FOUND', 'managed_failure'))
      .mockResolvedValueOnce({ metadata: { ...probe, state: { status: 'Stopped' } } })
      .mockResolvedValueOnce({ metadata: probe })
      .mockRejectedValueOnce(new IncusError('INCUS_NOT_FOUND', 'managed_failure'));
    const createInstance = vi.fn().mockResolvedValue({
      status: 202,
      envelope: {
        type: 'async',
        status: 'Operation created',
        status_code: 100,
        operation: '/1.0/operations/11111111-1111-4111-8111-111111111111',
        error_code: 0,
        error: '',
        metadata: null,
      },
      metadata: null,
    });
    const getOperationWait = vi.fn().mockRejectedValue(
      new IncusError('INCUS_NOT_FOUND', 'managed_failure', {
        status: 404,
        apiErrorCode: 404,
        error: 'Operation not found',
        path: '/1.0/operations/11111111-1111-4111-8111-111111111111/wait?timeout=120',
      }),
    );
    const deleteInstance = vi.fn().mockResolvedValue({
      status: 200,
      envelope: { type: 'sync', status_code: 200 },
    });
    const getInstanceState = vi
      .fn()
      .mockResolvedValueOnce({
        metadata: { status: 'Running' },
      })
      .mockResolvedValue({
        metadata: { status: 'Stopped' },
      });
    const updateInstanceState = vi.fn()
      .mockResolvedValueOnce({
        status: 202,
        envelope: {
          type: 'async',
          status: 'Operation created',
          status_code: 100,
          operation: '/1.0/operations/22222222-2222-4222-8222-222222222222',
          error_code: 0,
          error: '',
          metadata: null,
        },
        metadata: null,
      })
      .mockResolvedValue({
        status: 200,
        envelope: { type: 'sync', status_code: 200 },
      });
    const execInstance = vi.fn().mockResolvedValue({
      status: 200,
      envelope: { type: 'sync', status_code: 200, metadata: { return: 0 } },
      metadata: { return: 0 },
    });
    const client = {
      listStoragePools: vi.fn().mockResolvedValue({
        metadata: [{ name: 'default' }],
      }),
      getResources: vi.fn().mockResolvedValue({
        metadata: { gpu: { cards: [] }, storage: {}, system: {} },
      }),
      getInstanceFull,
      createInstance,
      getOperationWait,
      getInstanceState,
      updateInstanceState,
      deleteInstance,
      execInstance,
    };

    const result = await (
      instance as unknown as {
        runPreflight: (
          client: unknown,
          server: unknown,
          options: unknown,
          signal: AbortSignal,
        ) => Promise<unknown>;
      }
    ).runPreflight(
      client,
      {
        ...server(),
        system_pool_id: 'pool-1',
        node_metrics_endpoint: 'https://metrics.example.test/metrics',
        node_metrics_token_ciphertext: 'encrypted-token',
      },
      {
        probeImageAlias: 'pinned-preflight-alias',
        probeImageFingerprint: '',
        probePoolName: 'default',
        probeAddress: '169.254.255.254',
        sourceServer: 'https://127.0.0.1:18576',
      },
      new AbortController().signal,
    );

    expect(result).toMatchObject({ status: 'passed', controlReady: true });
    expect(createInstance).toHaveBeenCalledWith(
      {
        name: probeName,
        type: 'container',
        profiles: [],
        source: {
          type: 'image',
          alias: 'pinned-preflight-alias',
          server: 'https://127.0.0.1:18576',
          protocol: 'simplestreams',
        },
        config: {
          'user.nyabase.preflight': 'true',
          'user.nyabase.server_id': serverId.replaceAll('-', ''),
          'limits.memory': '256MiB',
          'security.privileged': 'false',
        },
        devices: {
          root: {
            type: 'disk',
            path: '/',
            pool: 'default',
            size: '1073741824',
          },
          eth0: {
            type: 'nic',
            nictype: 'macvlan',
            mode: 'bridge',
            name: 'eth0',
            parent: 'eth0',
            hwaddr: probeHwaddr,
          },
        },
        start: false,
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(execInstance).toHaveBeenCalled();
    expect(getOperationWait).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', {
      signal: expect.any(AbortSignal),
    });
    expect(updateInstanceState).toHaveBeenCalledWith(
      probeName,
      { action: 'start', force: false },
      { signal: expect.any(AbortSignal) },
    );
    expect(updateInstanceState).toHaveBeenCalledWith(
      probeName,
      { action: 'stop', force: true },
      { signal: expect.any(AbortSignal) },
    );
    expect(deleteInstance).toHaveBeenCalledWith(probeName, { signal: expect.any(AbortSignal) });
    expect(getInstanceFull).toHaveBeenCalledTimes(4);
  });

  it('records a retryable preflight failure as running', async () => {
    const db = database();
    const instance = reconciler(db);
    const internals = instance as unknown as {
      readServer: ReturnType<typeof vi.fn>;
      runPreflight: ReturnType<typeof vi.fn>;
      connect: ReturnType<typeof vi.fn>;
      checks: {
        checkNetworkPrerequisites: ReturnType<typeof vi.fn>;
        checkGpuToolkit: ReturnType<typeof vi.fn>;
      };
      nodeMetrics: {
        pull: ReturnType<typeof vi.fn>;
      };
    };
    internals.readServer = vi.fn().mockResolvedValue(server());
    internals.runPreflight = vi
      .fn()
      .mockRejectedValue(new IncusError('SERVER_UNREACHABLE', 'retry'));

    await expect(
      instance.reconcile({
        client: {} as never,
        intent: {
          kind: 'server.preflight',
          resourceType: 'server',
          serverId,
          targetGeneration: 1,
          request: {},
        } as never,
        claim: {} as never,
        lease: {} as never,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'SERVER_UNREACHABLE' });

    expect(db.updates[0]).toEqual({ preflight_status: 'running', status: 'unknown' });
    expect(db.updates[1]).toMatchObject({
      status: 'unreachable',
      preflight_status: 'running',
      preflight_report: expect.any(String),
    });
    expect(JSON.parse(String(db.updates[1]?.preflight_report))).toMatchObject({
      status: 'running',
      controlReady: false,
      checks: { api: 'fail' },
    });
  });

  it.each(['success', 'failure'] as const)(
    'does not project a %s result after the server revision changes',
    async (resultKind) => {
      const db = revisionRaceDatabase();
      const instance = reconciler(db as never);
      const internals = instance as unknown as {
        runPreflight: ReturnType<typeof vi.fn>;
      };
      internals.runPreflight =
        resultKind === 'success'
          ? vi.fn().mockResolvedValue({ status: 'passed' })
          : vi.fn().mockRejectedValue(new IncusError('PREFLIGHT_FAILED', 'managed_failure'));

      await expect(
        instance.reconcile({
          client: {} as never,
          intent: {
            kind: 'server.preflight',
            resourceType: 'server',
            serverId,
            targetGeneration: 1,
            request: {},
          } as never,
          claim: {} as never,
          lease: {} as never,
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({
        outcome: 'succeeded',
        stale: true,
      });
    },
  );

  it('rejects a preflight with no configured probe image', async () => {
    const db = database({
      incus_name: 'default',
      server_id: serverId,
      registered: true,
    });
    const instance = reconciler(db);
    const internals = instance as unknown as {
      connect: ReturnType<typeof vi.fn>;
      checks: {
        checkNetworkPrerequisites: ReturnType<typeof vi.fn>;
        checkGpuToolkit: ReturnType<typeof vi.fn>;
      };
      nodeMetrics: {
        pull: ReturnType<typeof vi.fn>;
      };
    };
    internals.connect = vi.fn().mockResolvedValue({
      metadata: {
        environment: { firewall: 'nftables' },
      },
    });
    const checks = internals.checks;
    checks.checkNetworkPrerequisites.mockResolvedValue({
      forwarding: true,
      rpFilter: true,
      fib: false,
      networkPrerequisites: true,
    });
    checks.checkGpuToolkit.mockResolvedValue({ gpuRuntime: 'not_applicable' });
    const nodeMetrics = internals.nodeMetrics;
    nodeMetrics.pull.mockResolvedValue({
      status: 'online',
      report: { samples: [] },
    });
    const client = {
      listStoragePools: vi.fn().mockResolvedValue({
        metadata: [{ name: 'default' }],
      }),
      getResources: vi.fn().mockResolvedValue({
        metadata: { gpu: { cards: [] }, storage: {}, system: {} },
      }),
    };

    await expect(
      (
        instance as unknown as {
          runPreflight: (
            client: unknown,
            server: unknown,
            options: unknown,
            signal: AbortSignal,
          ) => Promise<unknown>;
        }
      ).runPreflight(
        client,
        {
          ...server(),
          system_pool_id: 'pool-1',
          node_metrics_endpoint: 'https://metrics.example.test/metrics',
          node_metrics_token_ciphertext: 'encrypted-token',
        },
        {
          probeImageAlias: '',
          probeImageFingerprint: '',
          probePoolName: 'default',
          probeAddress: '169.254.255.254',
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'PREFLIGHT_FAILED',
      details: { reason: 'preflight_probe_options_missing' },
    });
  });

  it('warns and continues first preflight when node metrics pull fails', async () => {
    const db = database({
      incus_name: 'default',
      server_id: serverId,
      registered: true,
    });
    const instance = reconciler(db);
    const internals = instance as unknown as {
      connect: ReturnType<typeof vi.fn>;
      checks: {
        checkNetworkPrerequisites: ReturnType<typeof vi.fn>;
        checkGpuToolkit: ReturnType<typeof vi.fn>;
      };
      nodeMetrics: {
        pull: ReturnType<typeof vi.fn>;
      };
    };
    internals.connect = vi.fn().mockResolvedValue({
      metadata: {
        environment: { firewall: 'nftables' },
      },
    });
    internals.checks.checkNetworkPrerequisites.mockResolvedValue({
      forwarding: false,
      rpFilter: false,
      fib: false,
      networkPrerequisites: true,
    });
    internals.checks.checkGpuToolkit.mockResolvedValue({ gpuRuntime: 'not_applicable' });
    internals.nodeMetrics.pull.mockRejectedValue(
      new IncusError('PREFLIGHT_FAILED', 'managed_failure', {
        reason: 'node_metrics_pull_not_online',
      }),
    );
    const client = {
      listStoragePools: vi.fn().mockResolvedValue({
        metadata: [{ name: 'default' }],
      }),
      getResources: vi.fn().mockResolvedValue({
        metadata: { gpu: { cards: [] }, storage: {}, system: {} },
      }),
    };

    await expect(
      (
        instance as unknown as {
          runPreflight: (
            client: unknown,
            server: unknown,
            options: unknown,
            signal: AbortSignal,
          ) => Promise<unknown>;
        }
      ).runPreflight(
        client,
        {
          ...server(),
          preflight_status: 'not_run',
          system_pool_id: 'pool-1',
          node_metrics_endpoint: 'https://metrics.example.test/metrics',
          node_metrics_token_ciphertext: 'encrypted-token',
        },
        {
          probeImageAlias: '',
          probeImageFingerprint: '',
          probePoolName: 'default',
          probeAddress: '169.254.255.254',
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'PREFLIGHT_FAILED',
      details: { reason: 'preflight_probe_options_missing' },
    });
    expect(internals.checks.checkNetworkPrerequisites).toHaveBeenCalled();
  });
});
