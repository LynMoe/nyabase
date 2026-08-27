import { describe, expect, it, vi } from 'vitest';
import { IncusPreflightChecksAdapter } from './preflight-checks.adapter.js';

function database() {
  const updates: Array<Record<string, unknown>> = [];
  return {
    selectFrom: vi.fn(() => ({
      select: vi.fn(() => ({
        where: vi.fn(() => ({
          executeTakeFirst: vi.fn().mockResolvedValue({
            parent_interface: 'eth0',
          }),
        })),
      })),
    })),
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
    updates,
  };
}

function config(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    'incus.preflightEgressUrl': 'https://egress.example.test/health',
    'incus.operationWaitTimeoutMs': 120_000,
    ...overrides,
  };
  return {
    get: vi.fn((key: string) => values[key]),
  };
}

describe('IncusPreflightChecksAdapter', () => {
  it('keeps forwarding and rp_filter diagnostic when parent_interface is present', async () => {
    const adapter = new IncusPreflightChecksAdapter(database() as never, config() as never);

    await expect(adapter.checkNetworkPrerequisites('server-a', {
      samples: [
        {
          name: 'nyabase_node_network_forwarding',
          labels: { interface: 'eth0' },
          value: 1,
        },
        {
          name: 'nyabase_node_network_rp_filter',
          labels: { interface: 'eth0' },
          value: 0,
        },
      ],
    })).resolves.toEqual({
      serverId: 'server-a',
      forwarding: true,
      rpFilter: false,
      fib: false,
      networkPrerequisites: true,
    });
  });

  it('fails network prerequisites when parent_interface is missing', async () => {
    const adapter = new IncusPreflightChecksAdapter({
      ...database(),
      selectFrom: vi.fn(() => ({
        select: vi.fn(() => ({
          where: vi.fn(() => ({
            executeTakeFirst: vi.fn().mockResolvedValue({
              parent_interface: null,
            }),
          })),
        })),
      })),
    } as never, config() as never);

    await expect(adapter.checkNetworkPrerequisites('server-a', { samples: [] })).resolves.toMatchObject({
      networkPrerequisites: false,
    });
  });

  it('treats rp_filter loose mode (2) as enabled alongside strict (1)', async () => {
    const adapter = new IncusPreflightChecksAdapter(database() as never, config() as never);
    const samplesFor = (rpFilter: number) => ([
      {
        name: 'nyabase_node_network_forwarding',
        labels: { interface: 'eth0' },
        value: 1,
      },
      {
        name: 'nyabase_node_network_rp_filter',
        labels: { interface: 'eth0' },
        value: rpFilter,
      },
      {
        name: 'nyabase_node_network_fib_rule_present',
        labels: { interface: 'eth0' },
        value: 1,
      },
    ]);

    await expect(adapter.checkNetworkPrerequisites('server-a', {
      samples: samplesFor(1),
    })).resolves.toMatchObject({
      rpFilter: true,
      networkPrerequisites: true,
    });
    await expect(adapter.checkNetworkPrerequisites('server-a', {
      samples: samplesFor(2),
    })).resolves.toMatchObject({
      rpFilter: true,
      networkPrerequisites: true,
    });
  });

  it('passes GPU checks from Incus nvidia cards even without exporter samples', async () => {
    const adapter = new IncusPreflightChecksAdapter(database() as never, config() as never);
    const resources = {
      gpu: {
        cards: [{
          pci_address: '0000:01:00.0',
          nvidia: { driver: '550' },
        }],
      },
    };

    await expect(adapter.checkGpuToolkit('server-a', resources as never, {
      samples: [],
    })).resolves.toMatchObject({
      gpuRuntime: 'pass',
      gpuCount: 1,
      nvidiaCards: 1,
    });
    await expect(adapter.checkGpuToolkit('server-a', resources as never, {
      samples: [{
        name: 'nyabase_node_gpu_util_ratio',
        labels: { gpu_pci: '0000:01:00.0' },
        value: 0,
      }],
    })).resolves.toMatchObject({ gpuRuntime: 'pass' });
    await expect(adapter.checkGpuToolkit('server-a', resources as never, {
      samples: [{
        name: 'nyabase_node_gpu_util_ratio',
        // Metrics use the canonical 8-digit domain; Incus often reports 4-digit.
        labels: { gpu_pci: '00000000:01:00.0' },
        value: 0,
      }],
    })).resolves.toMatchObject({ gpuRuntime: 'pass' });
  });

  it('ignores non-NVIDIA display adapters when evaluating GPU runtime', async () => {
    const adapter = new IncusPreflightChecksAdapter(database() as never, config() as never);
    const resources = {
      gpu: {
        cards: [
          {
            pci_address: '0000:62:00.0',
            vendor: 'ASPEED Technology, Inc.',
            drm: { id: 0 },
          },
          {
            pci_address: '0000:a1:00.0',
            nvidia: { driver: '580' },
          },
        ],
      },
    };

    await expect(adapter.checkGpuToolkit('server-a', resources as never, {
      samples: [{
        name: 'nyabase_node_gpu_util_ratio',
        labels: { gpu_pci: '00000000:a1:00.0' },
        value: 0.1,
      }],
    })).resolves.toMatchObject({
      gpuRuntime: 'pass',
      gpuCount: 2,
      nvidiaCards: 1,
    });
  });

  it('does not fail first preflight solely for missing GPU exporter samples', async () => {
    const adapter = new IncusPreflightChecksAdapter(database() as never, config() as never);
    const resources = {
      gpu: {
        cards: [
          { pci_address: '0000:01:00.0', nvidia: { driver: '550' } },
          { pci_address: '0000:02:00.0', nvidia: { driver: '550' } },
        ],
      },
    };

    await expect(adapter.checkGpuToolkit('server-a', resources as never, {
      samples: [{
        name: 'nyabase_node_gpu_util_ratio',
        labels: { gpu_pci: '0000:01:00.0' },
        value: 0,
      }],
    })).resolves.toMatchObject({
      gpuRuntime: 'pass',
      gpuCount: 2,
      missingGpuPci: ['00000000:02:00.0'],
    });
  });

  it('clears the persisted GPU runtime status when no GPU remains', async () => {
    const db = database();
    const adapter = new IncusPreflightChecksAdapter(db as never, config() as never);

    await expect(adapter.checkGpuToolkit('server-a', {
      gpu: { cards: [] },
    } as never, {
      samples: [],
    })).resolves.toMatchObject({
      gpuRuntime: 'not_applicable',
      gpuCount: 0,
    });
    expect(db.updates).toContainEqual({ gpu_runtime_available: false });
  });

  it('runs egress through the fixed HTTPS target and records the operation proof', async () => {
    const execInstance = vi.fn().mockResolvedValue({
      status: 202,
      envelope: {
        type: 'async',
        operation: '/1.0/operations/probe-op',
      },
    });
    const getOperationWait = vi.fn().mockResolvedValue({
      status: 200,
      envelope: { type: 'sync' },
      metadata: {
        status: 'Success',
        status_code: 200,
        metadata: { return: 0 },
      },
    });
    const adapter = new IncusPreflightChecksAdapter(database() as never, config() as never);
    const client = { execInstance, getOperationWait } as never;

    await expect(adapter.checkEgress('server-a', client, 'probe-a')).resolves.toMatchObject({
      status: 'pass',
      target: 'https://egress.example.test/health',
    });
    expect(execInstance).toHaveBeenCalledWith(
      'probe-a',
      expect.objectContaining({
        command: [
          'wget',
          '-q',
          '-T',
          '10',
          '-O',
          '/dev/null',
          'https://egress.example.test/health',
        ],
        'record-output': true,
      }),
      expect.anything(),
    );
    expect(getOperationWait).toHaveBeenCalledWith(
      'probe-op',
      expect.objectContaining({ timeoutMs: 120_000 }),
    );
  });

  it('fails closed when the configured egress target is missing', async () => {
    const adapter = new IncusPreflightChecksAdapter(
      database() as never,
      config({ 'incus.preflightEgressUrl': '' }) as never,
    );

    await expect(adapter.checkEgress(
      'server-a',
      {} as never,
      'probe-a',
    )).rejects.toMatchObject({
      code: 'PREFLIGHT_FAILED',
      details: { reason: 'preflight_egress_target_unconfigured' },
    });
  });
});
