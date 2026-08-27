import { describe, expect, it, vi } from 'vitest';
import { CertificateRotationReconciler } from './certificate-rotation-reconciler.service.js';

const certificateIntent = {
  id: '00000000-0000-4000-8000-000000000001',
  kind: 'certificate.rotate',
  resourceType: 'certificate_rotation',
  resourceId: '00000000-0000-4000-8000-000000000002',
  serverId: null,
  requestedBy: null,
  targetGeneration: 2,
};

interface CertRow {
  id: string;
  generation: string;
  state: string;
  certificate_pem?: string;
  fingerprint?: string;
}

interface TrustRow {
  certificate_id: string;
  server_id: string;
  state: string;
  last_error: string | null;
  observed_at: Date | null;
}

interface ServerRow {
  id: string;
  status: string;
}

interface Filter {
  col: string;
  op: string;
  val: unknown;
}

function reconcileContext() {
  return {
    intent: certificateIntent as never,
    claim: {} as never,
    lease: {} as never,
    signal: new AbortController().signal,
  };
}

function createHarness(options: {
  certificates: CertRow[];
  servers: ServerRow[];
  trusts?: TrustRow[];
}) {
  const certificates = options.certificates.map((row) => ({ ...row }));
  const servers = options.servers.map((row) => ({ ...row }));
  const trusts: TrustRow[] = (options.trusts ?? []).map((row) => ({ ...row }));
  const trustUpdates: Array<Record<string, unknown>> = [];
  const certificateUpdates: Array<Record<string, unknown>> = [];
  let txnOpen = 0;
  const txnOpenDuringHttp: boolean[] = [];

  function matchFilters(row: Record<string, unknown>, filters: Filter[]): boolean {
    return filters.every((filter) => {
      const actual = row[filter.col];
      if (filter.op === '=' || filter.op === undefined) {
        return String(actual) === String(filter.val);
      }
      return true;
    });
  }

  function builder(table: string) {
    const filters: Filter[] = [];
    const handle: Record<string, ReturnType<typeof vi.fn>> = {};
    const self = (): typeof handle => handle;
    for (const method of [
      'selectAll',
      'select',
      'forUpdate',
      'orderBy',
      'returning',
      'returningAll',
      'onConflict',
      'columns',
      'doNothing',
    ]) {
      handle[method] = vi.fn(self);
    }
    handle.where = vi.fn((col: string, op: string, val: unknown) => {
      filters.push({ col, op, val });
      return handle;
    });
    handle.values = vi.fn((value: unknown) => {
      handle._values = value as never;
      return handle;
    });
    handle.set = vi.fn((values: Record<string, unknown>) => {
      handle._values = values as never;
      if (table === 'system.incus_client_certificate_trusts') {
        trustUpdates.push(values);
      } else if (table === 'system.incus_client_certificates') {
        certificateUpdates.push(values);
      }
      return handle;
    });
    handle.executeTakeFirst = vi.fn(async () => {
      const rows = executeRows(table, filters, handle._values);
      applyMutation(table, filters, handle._values);
      return Array.isArray(rows) ? rows[0] : rows;
    });
    handle.execute = vi.fn(async () => {
      const rows = executeRows(table, filters, handle._values);
      applyMutation(table, filters, handle._values);
      return Array.isArray(rows) ? rows : rows ? [rows] : [];
    });
    return handle;
  }

  function applyMutation(table: string, filters: Filter[], values: unknown): void {
    if (!values || typeof values !== 'object' || Array.isArray(values)) return;
    const patch = values as Record<string, unknown>;
    if (table === 'system.incus_client_certificate_trusts') {
      const certificateId = filters.find((filter) => filter.col === 'certificate_id')?.val;
      const serverId = filters.find((filter) => filter.col === 'server_id')?.val;
      const existing = trusts.find(
        (trust) => trust.certificate_id === certificateId && trust.server_id === serverId,
      );
      if (existing) Object.assign(existing, patch);
      return;
    }
    if (table === 'system.incus_client_certificates') {
      const id = filters.find((filter) => filter.col === 'id')?.val;
      const currentState = filters.find((filter) => filter.col === 'state')?.val;
      const row = certificates.find((certificate) => (
        (!id || certificate.id === id)
        && (!currentState || certificate.state === currentState)
      ));
      if (row && patch.state) {
        row.state = String(patch.state);
      }
    }
  }

  function executeRows(table: string, filters: Filter[], values: unknown): unknown {
    if (table === 'system.incus_client_certificates') {
      return certificates.filter((row) => matchFilters(row as never, filters));
    }
    if (table === 'infra.servers') {
      return servers.filter((row) => matchFilters(row as never, filters));
    }
    if (table === 'system.incus_client_certificate_trusts') {
      if (values && typeof values === 'object' && !Array.isArray(values) && 'certificate_id' in (values as object)) {
        return [];
      }
      if (Array.isArray(values)) {
        for (const value of values) {
          trusts.push(value as TrustRow);
        }
        return [];
      }
      return trusts.filter((row) => matchFilters(row as never, filters));
    }
    return [];
  }

  const transaction = {
    getExecutor: vi.fn(() => ({
      transformQuery: vi.fn((query: unknown) => query),
      compileQuery: vi.fn((query: unknown) => query),
      executeQuery: vi.fn().mockResolvedValue({ rows: [] }),
    })),
    selectFrom: vi.fn((table: string) => builder(table)),
    updateTable: vi.fn((table: string) => builder(table)),
    insertInto: vi.fn((table: string) => {
      const handle = builder(table);
      handle.values = vi.fn((value: unknown) => {
        handle._values = value as never;
        if (table === 'system.incus_client_certificate_trusts') {
          const rows = Array.isArray(value) ? value : [value];
          for (const row of rows) {
            const next = row as TrustRow;
            if (!trusts.some((trust) => (
              trust.certificate_id === next.certificate_id
              && trust.server_id === next.server_id
            ))) {
              trusts.push({
                ...next,
                last_error: next.last_error ?? null,
                observed_at: next.observed_at ?? null,
              });
            }
          }
        }
        return handle;
      });
      handle.onConflict = vi.fn(() => handle);
      return handle;
    }),
  };

  const database = {
    transaction: vi.fn(() => ({
      execute: vi.fn(async (callback: (executor: typeof transaction) => Promise<unknown>) => {
        txnOpen += 1;
        try {
          return await callback(transaction);
        } finally {
          txnOpen -= 1;
        }
      }),
    })),
  };

  function trackHttp<T>(work: () => Promise<T>): Promise<T> {
    txnOpenDuringHttp.push(txnOpen > 0);
    return work();
  }

  return {
    database,
    transaction,
    certificates,
    trusts,
    servers,
    trustUpdates,
    certificateUpdates,
    txnOpenDuringHttp,
    isTxnOpen: () => txnOpen > 0,
    trackHttp,
  };
}

describe('CertificateRotationReconciler', () => {
  it('claims certificate rotation intents by their resource type', () => {
    const reconciler = new CertificateRotationReconciler({} as never);

    expect(reconciler.supports(certificateIntent as never)).toBe(true);
    expect(
      reconciler.supports({
        ...certificateIntent,
        resourceType: 'container',
      } as never),
    ).toBe(false);
  });

  it('settles an already-observed generation idempotently', async () => {
    const harness = createHarness({
      certificates: [{
        id: '00000000-0000-4000-8000-000000000010',
        generation: '2',
        state: 'active',
        fingerprint: 'aa'.repeat(32),
      }],
      servers: [],
    });
    const reconciler = new CertificateRotationReconciler(
      harness.database as never,
      { get: vi.fn(), invalidate: vi.fn() } as never,
    );

    await expect(reconciler.reconcile(reconcileContext())).resolves.toEqual({
      outcome: 'succeeded',
      observedGeneration: 2,
    });
  });

  it('trusts and verifies every online server before activating the staged candidate', async () => {
    const serverId = '00000000-0000-4000-8000-000000000020';
    const active = {
      id: '00000000-0000-4000-8000-000000000010',
      generation: '1',
      state: 'active',
      fingerprint: 'bb'.repeat(32),
      certificate_pem: 'active-certificate',
    };
    const candidate = {
      id: '00000000-0000-4000-8000-000000000011',
      generation: '2',
      state: 'staged',
      fingerprint: 'cc'.repeat(32),
      certificate_pem: 'candidate-certificate',
    };
    const harness = createHarness({
      certificates: [active, candidate],
      servers: [{ id: serverId, status: 'online' }],
      trusts: [{
        certificate_id: candidate.id,
        server_id: serverId,
        state: 'pending',
        last_error: null,
        observed_at: null,
      }],
    });
    const activeClient = {
      trustCertificate: vi.fn().mockImplementation(async () => {
        return harness.trackHttp(async () => ({
          status: 200,
          envelope: { type: 'sync' },
        }));
      }),
      deleteClientCertificate: vi.fn().mockImplementation(async () => {
        return harness.trackHttp(async () => ({ status: 200 }));
      }),
    };
    const candidateClient = {
      getServer: vi.fn().mockImplementation(async () => {
        return harness.trackHttp(async () => ({ status: 200 }));
      }),
    };
    const clients = {
      get: vi.fn().mockResolvedValue(activeClient),
      getForCertificate: vi.fn().mockResolvedValue(candidateClient),
      invalidate: vi.fn(),
    };
    const audit = { log: vi.fn().mockResolvedValue(undefined) };
    const reconciler = new CertificateRotationReconciler(
      harness.database as never,
      clients as never,
      audit as never,
    );

    await expect(reconciler.reconcile(reconcileContext())).resolves.toEqual({
      outcome: 'succeeded',
      observedGeneration: 2,
    });

    expect(activeClient.trustCertificate).toHaveBeenCalledWith(
      'candidate-certificate',
      `nyabase-${serverId.replaceAll('-', '')}`,
      expect.anything(),
    );
    expect(candidateClient.getServer).toHaveBeenCalledOnce();
    expect(harness.trustUpdates).toContainEqual({
      state: 'trusted',
      last_error: null,
      observed_at: null,
    });
    expect(harness.trustUpdates).toContainEqual({
      state: 'verified',
      last_error: null,
      observed_at: expect.any(Date),
    });
    expect(harness.certificateUpdates).toEqual(expect.arrayContaining([
      { state: 'retired', retired_at: expect.any(Date) },
      { state: 'active', activated_at: expect.any(Date), retired_at: null },
    ]));
    expect(clients.invalidate).toHaveBeenCalledOnce();
    expect(activeClient.deleteClientCertificate).toHaveBeenCalledWith('bb'.repeat(32));
    expect(audit.log).toHaveBeenCalledWith(
      null,
      'incus.mutate',
      certificateIntent.resourceId,
      'certificate_rotation',
      expect.objectContaining({
        method: 'POST',
        path: '/1.0/certificates',
        serverId,
      }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      null,
      'incus.mutate',
      certificateIntent.resourceId,
      'certificate_rotation',
      expect.objectContaining({
        method: 'DELETE',
        path: `/1.0/certificates/${'bb'.repeat(32)}`,
        serverId,
      }),
    );
    expect(harness.trustUpdates).toContainEqual({
      state: 'revoked',
      last_error: null,
      observed_at: expect.any(Date),
    });
  });

  it('activates when every online server is verified even if an unknown server is still pending', async () => {
    const onlineId = '00000000-0000-4000-8000-000000000021';
    const unknownId = '00000000-0000-4000-8000-000000000022';
    const active = {
      id: '00000000-0000-4000-8000-000000000012',
      generation: '1',
      state: 'active',
      fingerprint: '11'.repeat(32),
    };
    const candidate = {
      id: '00000000-0000-4000-8000-000000000013',
      generation: '2',
      state: 'staged',
      fingerprint: '22'.repeat(32),
      certificate_pem: 'candidate-certificate',
    };
    const harness = createHarness({
      certificates: [active, candidate],
      servers: [
        { id: onlineId, status: 'online' },
        { id: unknownId, status: 'unknown' },
      ],
      trusts: [
        {
          certificate_id: candidate.id,
          server_id: onlineId,
          state: 'pending',
          last_error: null,
          observed_at: null,
        },
        {
          certificate_id: candidate.id,
          server_id: unknownId,
          state: 'pending',
          last_error: null,
          observed_at: null,
        },
      ],
    });
    const activeClient = {
      trustCertificate: vi.fn().mockResolvedValue({
        status: 200,
        envelope: { type: 'sync' },
      }),
      deleteClientCertificate: vi.fn().mockResolvedValue({ status: 404 }),
    };
    const clients = {
      get: vi.fn().mockResolvedValue(activeClient),
      getForCertificate: vi.fn().mockResolvedValue({
        getServer: vi.fn().mockResolvedValue({ status: 200 }),
      }),
      invalidate: vi.fn(),
    };
    const reconciler = new CertificateRotationReconciler(
      harness.database as never,
      clients as never,
    );

    await expect(reconciler.reconcile(reconcileContext())).resolves.toEqual({
      outcome: 'succeeded',
      observedGeneration: 2,
    });
    expect(clients.getForCertificate).toHaveBeenCalledWith(onlineId, candidate.id);
    expect(clients.getForCertificate).not.toHaveBeenCalledWith(unknownId, candidate.id);
    expect(harness.trusts.find((trust) => trust.server_id === unknownId)?.state).toBe('pending');
    expect(harness.trusts.find((trust) => trust.server_id === unknownId)?.last_error).toMatch(
      /needs_attention/,
    );
  });

  it('does not invoke Incus HTTP while a PostgreSQL transaction is still open', async () => {
    const serverId = '00000000-0000-4000-8000-000000000023';
    const active = {
      id: '00000000-0000-4000-8000-000000000014',
      generation: '1',
      state: 'active',
      fingerprint: '33'.repeat(32),
    };
    const candidate = {
      id: '00000000-0000-4000-8000-000000000015',
      generation: '2',
      state: 'staged',
      fingerprint: '44'.repeat(32),
      certificate_pem: 'candidate-certificate',
    };
    const harness = createHarness({
      certificates: [active, candidate],
      servers: [{ id: serverId, status: 'online' }],
      trusts: [{
        certificate_id: candidate.id,
        server_id: serverId,
        state: 'pending',
        last_error: null,
        observed_at: null,
      }],
    });
    const activeClient = {
      trustCertificate: vi.fn().mockImplementation(async () => {
        return harness.trackHttp(async () => ({
          status: 200,
          envelope: { type: 'sync' },
        }));
      }),
      deleteClientCertificate: vi.fn().mockImplementation(async () => {
        return harness.trackHttp(async () => ({ status: 404 }));
      }),
    };
    const candidateClient = {
      getServer: vi.fn().mockImplementation(async () => {
        return harness.trackHttp(async () => ({ status: 200 }));
      }),
    };
    const reconciler = new CertificateRotationReconciler(
      harness.database as never,
      {
        get: vi.fn().mockResolvedValue(activeClient),
        getForCertificate: vi.fn().mockResolvedValue(candidateClient),
        invalidate: vi.fn(),
      } as never,
    );

    await reconciler.reconcile(reconcileContext());

    expect(harness.txnOpenDuringHttp.length).toBeGreaterThan(0);
    expect(harness.txnOpenDuringHttp.every((open) => open === false)).toBe(true);
    expect(activeClient.deleteClientCertificate).toHaveBeenCalledOnce();
  });

  it('treats a 404 from DELETE of the old certificate as successful revoke', async () => {
    const serverId = '00000000-0000-4000-8000-000000000024';
    const active = {
      id: '00000000-0000-4000-8000-000000000016',
      generation: '1',
      state: 'active',
      fingerprint: '55'.repeat(32),
    };
    const candidate = {
      id: '00000000-0000-4000-8000-000000000017',
      generation: '2',
      state: 'staged',
      fingerprint: '66'.repeat(32),
      certificate_pem: 'candidate-certificate',
    };
    const harness = createHarness({
      certificates: [active, candidate],
      servers: [{ id: serverId, status: 'online' }],
      trusts: [{
        certificate_id: candidate.id,
        server_id: serverId,
        state: 'pending',
        last_error: null,
        observed_at: null,
      }],
    });
    const activeClient = {
      trustCertificate: vi.fn().mockResolvedValue({
        status: 200,
        envelope: { type: 'sync' },
      }),
      deleteClientCertificate: vi.fn().mockResolvedValue({ status: 404 }),
    };
    const reconciler = new CertificateRotationReconciler(
      harness.database as never,
      {
        get: vi.fn().mockResolvedValue(activeClient),
        getForCertificate: vi.fn().mockResolvedValue({
          getServer: vi.fn().mockResolvedValue({ status: 200 }),
        }),
        invalidate: vi.fn(),
      } as never,
    );

    await expect(reconciler.reconcile(reconcileContext())).resolves.toEqual({
      outcome: 'succeeded',
      observedGeneration: 2,
    });
    expect(activeClient.deleteClientCertificate).toHaveBeenCalledWith('55'.repeat(32));
    expect(harness.trusts.some((trust) => (
      trust.certificate_id === active.id && trust.state === 'revoked'
    ))).toBe(true);
  });

  it('returns a retry without retiring the active certificate when online trust fails', async () => {
    const serverId = '00000000-0000-4000-8000-000000000052';
    const active = {
      id: '00000000-0000-4000-8000-000000000050',
      generation: '1',
      state: 'active',
      fingerprint: '77'.repeat(32),
    };
    const candidate = {
      id: '00000000-0000-4000-8000-000000000051',
      generation: '2',
      state: 'staged',
      fingerprint: '88'.repeat(32),
      certificate_pem: 'candidate-certificate',
    };
    const harness = createHarness({
      certificates: [active, candidate],
      servers: [{ id: serverId, status: 'online' }],
      trusts: [{
        certificate_id: candidate.id,
        server_id: serverId,
        state: 'pending',
        last_error: null,
        observed_at: null,
      }],
    });
    const reconciler = new CertificateRotationReconciler(
      harness.database as never,
      {
        get: vi.fn().mockResolvedValue({
          trustCertificate: vi.fn().mockRejectedValue(new Error('temporary trust failure')),
        }),
        getForCertificate: vi.fn(),
      } as never,
    );

    await expect(reconciler.reconcile(reconcileContext())).resolves.toMatchObject({
      outcome: 'retry',
      failure: {
        code: 'CERTIFICATE_ROTATION_TRUST_PENDING',
      },
    });

    expect(harness.certificateUpdates).toEqual([]);
    expect(harness.trustUpdates).toContainEqual({
      state: 'pending',
      last_error: '[attempts=1] temporary trust failure',
      observed_at: null,
    });
  });

  it('does not activate when a new online server appears before cutover', async () => {
    const firstServer = '00000000-0000-4000-8000-000000000040';
    const joiningServer = '00000000-0000-4000-8000-000000000041';
    const active = {
      id: '00000000-0000-4000-8000-000000000030',
      generation: '1',
      state: 'active',
      fingerprint: '99'.repeat(32),
    };
    const candidate = {
      id: '00000000-0000-4000-8000-000000000031',
      generation: '2',
      state: 'staged',
      fingerprint: 'aa'.repeat(32),
      certificate_pem: 'candidate-certificate',
    };
    const harness = createHarness({
      certificates: [active, candidate],
      servers: [{ id: firstServer, status: 'online' }],
      trusts: [{
        certificate_id: candidate.id,
        server_id: firstServer,
        state: 'pending',
        last_error: null,
        observed_at: null,
      }],
    });
    const originalSelect = harness.transaction.selectFrom;
    let serverReads = 0;
    harness.transaction.selectFrom = vi.fn((table: string) => {
      const handle = originalSelect(table);
      if (table === 'infra.servers') {
        const originalExecute = handle.execute as () => Promise<unknown>;
        handle.execute = vi.fn(async () => {
          serverReads += 1;
          if (serverReads >= 2 && !harness.servers.some((server) => server.id === joiningServer)) {
            harness.servers.push({ id: joiningServer, status: 'online' });
          }
          return originalExecute();
        });
      }
      return handle;
    });
    const reconciler = new CertificateRotationReconciler(
      harness.database as never,
      {
        get: vi.fn().mockResolvedValue({
          trustCertificate: vi.fn().mockResolvedValue({
            status: 200,
            envelope: { type: 'sync' },
          }),
          deleteClientCertificate: vi.fn(),
        }),
        getForCertificate: vi.fn().mockResolvedValue({
          getServer: vi.fn().mockResolvedValue({ status: 200 }),
        }),
        invalidate: vi.fn(),
      } as never,
    );

    await expect(reconciler.reconcile(reconcileContext())).resolves.toMatchObject({
      outcome: 'retry',
      failure: {
        code: 'CERTIFICATE_ROTATION_TRUST_PENDING',
      },
    });
    expect(harness.certificateUpdates).toEqual([]);
  });
});
