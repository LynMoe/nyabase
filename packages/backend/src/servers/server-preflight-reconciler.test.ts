import { describe, expect, it, vi } from 'vitest';
import { deriveGuestHwaddr, IncusError } from '../incus/index.js';
import { ServerConnector } from './server-connector.js';
import { ServerPreflightStore } from './server-preflight.store.js';
import { ServerPreflightReconciler } from './server-preflight-reconciler.service.js';
import { evaluateLanBridge } from './preflight-checks.adapter.js';
import { cleanupStaleProbe } from './server-preflight-probe.js';

const serverId = '00000000-0000-4000-8000-000000000001';
const TWO_CPUS = {
  sockets: [{ socket: 0, cores: [{ core: 0, threads: [{ id: 0, numa_node: 0, online: true }, { id: 1, numa_node: 0, online: true }] }] }],
};


function database(selectResult?: unknown) {
  const updates: Array<Record<string, unknown>> = [];
  const builder = (table: string) => {
    const query: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const method of ['select', 'selectAll', 'where', 'forUpdate', 'orderBy', 'innerJoin']) {
      query[method] = vi.fn(() => query);
    }
    query.executeTakeFirst = vi
      .fn()
      .mockResolvedValue(
        String(table).includes('ip_pool')
          ? { gateway: '192.0.2.1', cidr: '192.0.2.0/24' }
          : selectResult,
      );
    query.execute = vi.fn().mockResolvedValue(
      String(table).includes('ip_pool')
        ? [{ gateway: '192.0.2.1', cidr: '192.0.2.0/24' }]
        : [],
    );
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
    updates,
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

/** The reconciler's collaborators, where the tests intercept connect/preflight/data access. */
function partsOf(instance: ServerPreflightReconciler) {
  return instance as unknown as {
    connector: { connect: unknown };
    runPreflight: unknown;
    store: { readServer: unknown };
    checks: unknown;
    nodeMetrics: unknown;
  };
}


function runnerOf(instance: ServerPreflightReconciler): object {
  return instance;
}

/** One object exposing the replaceable steps under their old names. */
function internalsOf(instance: ServerPreflightReconciler): object {
  const parts = partsOf(instance);
  return {
    get checks() { return parts.checks; },
    get nodeMetrics() { return parts.nodeMetrics; },
    set connect(value: unknown) { parts.connector.connect = value; },
    set runPreflight(value: unknown) { parts.runPreflight = value; },
    set readServer(value: unknown) { parts.store.readServer = value; },
  };
}


function passingLanNetwork() {
  return {
    parentInterface: 'eth0',
    isBridge: true,
    nftAvailable: true,
    slaves: ['bond0'],
    ipv4Present: { eth0: true, bond0: false },
    slavesWithIpv4: [],
    hasUplink: true,
    networkPrerequisites: true,
  };
}

function lanSamples(probeAddress = '169.254.255.254') {
  return [
    { name: 'nyabase_node_network_is_bridge', labels: { interface: 'eth0' }, value: 1 },
    { name: 'nyabase_node_network_ipv4_present', labels: { interface: 'eth0' }, value: 1 },
    { name: 'nyabase_node_network_ipv4_present', labels: { interface: 'bond0' }, value: 0 },
    {
      name: 'nyabase_node_network_bridge_slave',
      labels: { bridge: 'eth0', interface: 'bond0' },
      value: 1,
    },
    { name: 'nyabase_node_network_nft_available', labels: {}, value: 1 },
    { name: 'nyabase_node_ipv6_guard_present', labels: {}, value: 1 },
    {
      name: 'nyabase_node_network_bridge_filter_address',
      labels: { address: probeAddress },
      value: 1,
    },
  ];
}

function lanClient(extra: Record<string, unknown> = {}) {
  return {
    getNetwork: vi.fn().mockResolvedValue({
      metadata: { type: 'bridge', managed: false, name: 'eth0' },
    }),
    getNetworkState: vi.fn().mockResolvedValue({
      metadata: {
        addresses: [{ family: 'inet', scope: 'global', address: '192.0.2.1' }],
        bridge: { upper_devices: ['bond0'] },
      },
    }),
    listNetworks: vi.fn().mockResolvedValue({
      metadata: ['eth0'],
    }),
    ...extra,
  };
}

function server() {
  return {
    id: serverId,
    name: 'test-server',
    parent_interface: 'eth0',
    status: 'unknown',
    system_pool_id: null,
    preflight_status: 'not_run',
    revision: 1,
  };
}

function reconciler(db: ReturnType<typeof database>) {
  const store = new ServerPreflightStore(db as never);
  return new ServerPreflightReconciler(
    store,
    new ServerConnector(store),
    {
      pull: vi.fn(),
    } as never,
    {
      checkNetworkPrerequisites: vi.fn(),
      checkEgress: vi.fn(),
      checkGuestCanReachHost: vi.fn(),
    } as never,
    {
      get: vi.fn(
        (key: string) =>
          ({
            'incus.preflightImageAlias': 'ubuntu/24.04',
            'incus.preflightImageFingerprint': '',
            'incus.preflightSourceServer': 'https://nyabase-images.nyabase-lxc-images.workers.dev',
          })[key],
      ),
    } as never,
    { register: vi.fn() } as never,
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
  it('fails preflight unless reserved CPUs exist and leave a CPU for containers', async () => {
    const check = (reserved: number[]) => (reconciler(database({ reserved_cpus: reserved })) as unknown as {
      requireUnreservedCpus: (serverId: string, resources: unknown) => Promise<void>;
    }).requireUnreservedCpus(serverId, { cpu: TWO_CPUS });
    await expect(check([0])).resolves.toBeUndefined();
    await expect(check([0, 1])).rejects.toMatchObject({ details: { reason: 'no_unreserved_cpus' } });
    await expect(check([7])).rejects.toMatchObject({ details: { reason: 'reserved_cpu_unknown' } });
    await expect((reconciler(database({ reserved_cpus: [] })) as unknown as {
      requireUnreservedCpus: (serverId: string, resources: unknown) => Promise<void>;
    }).requireUnreservedCpus(serverId, {})).rejects.toMatchObject({ details: { reason: 'cpu_topology_unknown' } });
  });

  it('cleans up a stale managed probe after stopping it and verifies absence', async () => {
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
    await cleanupStaleProbe(
      client as never,
      'nyabase-preflight-test',
      serverId,
      new AbortController().signal,
    );

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
    const internals = internalsOf(instance) as unknown as {
      connect: ReturnType<typeof vi.fn>;
      checks: {
        checkNetworkPrerequisites: ReturnType<typeof vi.fn>;
        checkEgress: ReturnType<typeof vi.fn>;
        checkGuestCanReachHost: ReturnType<typeof vi.fn>;
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
    internals.checks.checkNetworkPrerequisites.mockResolvedValue(passingLanNetwork());
    internals.checks.checkEgress.mockResolvedValue({ status: 'pass' });
    internals.checks.checkGuestCanReachHost.mockResolvedValue({ status: 'pass' });
    internals.nodeMetrics.pull.mockResolvedValue({
      status: 'online',
      report: { samples: lanSamples() },
    });

    const probeName = `nyabase-preflight-${serverId.replaceAll('-', '')}`;
    const probeHwaddr = deriveGuestHwaddr('169.254.255.254');
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
    const client = lanClient({
      listStoragePools: vi.fn().mockResolvedValue({
        metadata: [{ name: 'default' }],
      }),
      getResources: vi.fn().mockResolvedValue({
        metadata: { cpu: TWO_CPUS, gpu: { cards: [] }, storage: {}, system: {} },
      }),
      getInstanceFull,
      createInstance,
      getOperationWait,
      getInstanceState,
      updateInstanceState,
      deleteInstance,
      execInstance,
    });

    const result = await (
      runnerOf(instance) as unknown as {
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
          'security.idmap.isolated': 'true',
          'linux.sysctl.net.ipv6.conf.all.disable_ipv6': '1',
          'linux.sysctl.net.ipv6.conf.default.disable_ipv6': '1',
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
            nictype: 'bridged',
            name: 'eth0',
            parent: 'eth0',
            hwaddr: probeHwaddr,
            host_name: expect.stringMatching(/^nyh[0-9a-f]{12}$/),
            'ipv4.address': '169.254.255.254',
            'security.ipv4_filtering': 'true',
            'security.mac_filtering': 'true',
            'security.port_isolation': 'true',
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
    expect(internals.nodeMetrics.pull).toHaveBeenCalledTimes(2);
    expect(internals.checks.checkGuestCanReachHost).toHaveBeenCalledWith(
      serverId,
      expect.anything(),
      probeName,
      '192.0.2.1',
      expect.any(AbortSignal),
    );
  });

  it('records a retryable preflight failure as running', async () => {
    const db = database();
    const instance = reconciler(db);
    const internals = internalsOf(instance) as unknown as {
      readServer: ReturnType<typeof vi.fn>;
      runPreflight: ReturnType<typeof vi.fn>;
      connect: ReturnType<typeof vi.fn>;
      checks: {
        checkNetworkPrerequisites: ReturnType<typeof vi.fn>;
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
          targetRevision: 1,
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
      const internals = internalsOf(instance) as unknown as {
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
            targetRevision: 1,
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
    const internals = internalsOf(instance) as unknown as {
      connect: ReturnType<typeof vi.fn>;
      checks: {
        checkNetworkPrerequisites: ReturnType<typeof vi.fn>;
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
    checks.checkNetworkPrerequisites.mockResolvedValue(passingLanNetwork());
    const nodeMetrics = internals.nodeMetrics;
    nodeMetrics.pull.mockResolvedValue({
      status: 'online',
      report: { samples: lanSamples() },
    });
    const client = lanClient({
      listStoragePools: vi.fn().mockResolvedValue({
        metadata: [{ name: 'default' }],
      }),
      getResources: vi.fn().mockResolvedValue({
        metadata: { cpu: TWO_CPUS, gpu: { cards: [] }, storage: {}, system: {} },
      }),
    });

    await expect(
      (
        runnerOf(instance) as unknown as {
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

  it('fails closed when node metrics pull cannot prove nft availability', async () => {
    const db = database({
      incus_name: 'default',
      server_id: serverId,
      registered: true,
    });
    const instance = reconciler(db);
    const internals = internalsOf(instance) as unknown as {
      connect: ReturnType<typeof vi.fn>;
      checks: {
        checkNetworkPrerequisites: ReturnType<typeof vi.fn>;
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
      ...passingLanNetwork(),
      nftAvailable: false,
      networkPrerequisites: false,
    });
    internals.nodeMetrics.pull.mockRejectedValue(
      new IncusError('PREFLIGHT_FAILED', 'managed_failure', {
        reason: 'node_metrics_pull_not_online',
      }),
    );
    const client = lanClient({
      listStoragePools: vi.fn().mockResolvedValue({
        metadata: [{ name: 'default' }],
      }),
      getResources: vi.fn().mockResolvedValue({
        metadata: { cpu: TWO_CPUS, gpu: { cards: [] }, storage: {}, system: {} },
      }),
    });

    await expect(
      (
        runnerOf(instance) as unknown as {
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
      details: { reason: 'preflight_nft_unavailable' },
    });
    expect(internals.checks.checkNetworkPrerequisites).toHaveBeenCalled();
  });

  it('fails closed when no host IPv4 in a bound pool cidr can be proven', async () => {
    const db = database({
      incus_name: 'default',
      server_id: serverId,
      registered: true,
    });
    const instance = reconciler(db);
    const internals = internalsOf(instance) as unknown as {
      connect: ReturnType<typeof vi.fn>;
      checks: {
        checkNetworkPrerequisites: ReturnType<typeof vi.fn>;
      };
      nodeMetrics: {
        pull: ReturnType<typeof vi.fn>;
      };
    };
    internals.connect = vi.fn().mockResolvedValue({
      metadata: { environment: { firewall: 'nftables' } },
    });
    internals.checks.checkNetworkPrerequisites.mockResolvedValue(passingLanNetwork());
    internals.nodeMetrics.pull.mockResolvedValue({
      status: 'online',
      report: { samples: lanSamples() },
    });
    const client = lanClient({
      listStoragePools: vi.fn().mockResolvedValue({
        metadata: [{ name: 'default' }],
      }),
      getResources: vi.fn().mockResolvedValue({
        metadata: { cpu: TWO_CPUS, gpu: { cards: [] }, storage: {}, system: {} },
      }),
    });
    client.getNetwork.mockRejectedValue(new IncusError('INCUS_NOT_FOUND', 'managed_failure'));
    client.getNetworkState.mockRejectedValue(new IncusError('INCUS_NOT_FOUND', 'managed_failure'));
    client.listNetworks.mockResolvedValue({ metadata: [] });

    await expect(
      (
        runnerOf(instance) as unknown as {
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
        },
        {
          probeImageAlias: 'ubuntu/24.04',
          probeImageFingerprint: '',
          probePoolName: 'default',
          probeAddress: '169.254.255.254',
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'PREFLIGHT_FAILED',
      details: { reason: 'preflight_host_ip_not_in_pool' },
    });
  });

  it('accepts host IPv4 on a management NIC while vmbr0 is a dedicated container uplink', () => {
    const result = evaluateLanBridge({
      parentInterface: 'vmbr0',
      network: {
        parentInterface: 'vmbr0',
        isBridge: true,
        nftAvailable: true,
        slaves: ['eth1'],
        ipv4Present: { eth1: false, eth0: true },
        slavesWithIpv4: [],
        hasUplink: true,
        networkPrerequisites: true,
      },
      lookup: {
        networkMissing: false,
        stateMissing: false,
        network: { type: 'bridge', managed: false, name: 'vmbr0' },
        state: { addresses: [], bridge: { upper_devices: ['eth1'] } },
      },
      pools: [{ gateway: '192.0.2.1', cidr: '192.0.2.0/24', prefixLength: 24 }],
      samples: [
        { name: 'nyabase_node_network_is_bridge', labels: { interface: 'vmbr0' }, value: 1 },
        { name: 'nyabase_node_network_ipv4_present', labels: { interface: 'eth1' }, value: 0 },
        { name: 'nyabase_node_network_nft_available', labels: {}, value: 1 },
      ],
      extraHostAddresses: ['192.0.2.8'],
    });
    expect(result.reason).toBeUndefined();
    expect(result.hostIpv4).toBe('192.0.2.8');
  });

  it('fails closed when a bridge slave has no ipv4_present sample', () => {
    const result = evaluateLanBridge({
      parentInterface: 'vmbr0',
      network: {
        parentInterface: 'vmbr0',
        isBridge: true,
        nftAvailable: true,
        slaves: ['eth1'],
        ipv4Present: { eth0: true },
        slavesWithIpv4: [],
        hasUplink: true,
        networkPrerequisites: true,
      },
      lookup: {
        networkMissing: false,
        stateMissing: false,
        network: { type: 'bridge', managed: false, name: 'vmbr0' },
        state: { addresses: [], bridge: { upper_devices: ['eth1'] } },
      },
      pools: [{ gateway: '192.0.2.1', cidr: '192.0.2.0/24', prefixLength: 24 }],
      samples: [
        { name: 'nyabase_node_network_is_bridge', labels: { interface: 'vmbr0' }, value: 1 },
        { name: 'nyabase_node_network_nft_available', labels: {}, value: 1 },
      ],
      extraHostAddresses: ['192.0.2.8'],
    });
    expect(result).toMatchObject({ reason: 'preflight_slave_ipv4_unproven' });
  });
});
