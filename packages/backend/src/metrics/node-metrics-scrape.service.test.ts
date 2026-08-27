import { describe, expect, it, vi } from 'vitest';
import { NodeMetricsStatus } from '@nyabase/common';
import { NodeMetricsScrapeService } from './node-metrics-scrape.service.js';

const serverId = '00000000-0000-4000-8000-000000000001';

function makeDatabase(
  server: Record<string, unknown>,
  currentServer: Record<string, unknown> = server,
) {
  const row = {
    revision: 1,
    node_metrics_token_fingerprint: 'token-fingerprint-a',
    ...server,
  };
  let currentRow = currentServer === server ? row : { ...row, ...currentServer };
  const updates: Array<Record<string, unknown>> = [];
  const whereClauses: unknown[][] = [];
  const updateTable = vi.fn(() => ({
    set: vi.fn((values: Record<string, unknown>) => {
      updates.push(values);
      const updateQuery = {
        where: vi.fn((...args: unknown[]) => {
          whereClauses.push(args);
          return updateQuery;
        }),
        execute: vi.fn().mockResolvedValue(undefined),
      };
      return updateQuery;
    }),
  }));
  const executeTakeFirst = vi.fn().mockImplementation(async () => currentRow);
  const query = {
    select: vi.fn(() => query),
    where: vi.fn(() => query),
    execute: vi.fn().mockResolvedValue([row]),
    executeTakeFirst,
  };
  return {
    database: {
      selectFrom: vi.fn(() => query),
      updateTable,
    },
    updates,
    whereClauses,
    executeTakeFirst,
    getCurrentServer: () => currentRow,
    setCurrentServer: (next: Record<string, unknown>) => {
      currentRow = { ...row, ...next };
    },
  };
}

function service(
  database: ReturnType<typeof makeDatabase>['database'],
  pull: ReturnType<typeof vi.fn>,
  writeBatch = vi.fn().mockResolvedValue(undefined),
  runsWorker = false,
) {
  return new NodeMetricsScrapeService(
    database as never,
    { pull } as never,
    { writeBatch } as never,
    { runsWorker: () => runsWorker } as never,
  );
}

describe('NodeMetricsScrapeService', () => {
  it('marks an exporter unreachable only after three failed cycles', async () => {
    const pull = vi.fn().mockRejectedValue({ code: 'NODE_METRICS_UNREACHABLE' });
    const db = makeDatabase({
      id: serverId,
      node_metrics_endpoint: 'https://node.example.test/metrics',
      node_metrics_token_ciphertext: 'rfs-v1.cipher.tag',
      node_metrics_status: NodeMetricsStatus.Unknown,
      node_metrics_last_success_at: null,
    });
    const writeBatch = vi.fn().mockResolvedValue(undefined);
    const scraper = service(db.database, pull, writeBatch);

    await scraper.scrapeAll();
    await scraper.scrapeAll();
    await scraper.scrapeAll();

    const statuses = db.updates
      .map((update) => update.node_metrics_status)
      .filter((value): value is string => typeof value === 'string');
    expect(statuses).toEqual([
      NodeMetricsStatus.Unknown,
      NodeMetricsStatus.Unknown,
      NodeMetricsStatus.Unreachable,
    ]);
    expect(writeBatch).toHaveBeenCalledTimes(3);
    expect(writeBatch.mock.calls[2]?.[1]).toEqual([expect.objectContaining({
      name: 'nyabase_node_scrape_up',
      value: 0,
    })]);
  });

  it('writes fresh samples on success and only a gap marker after failure', async () => {
    const pull = vi.fn()
      .mockResolvedValueOnce({
        status: 'online',
        report: {
          endpoint: 'https://node.example.test/metrics',
          contentType: 'text/plain',
          sampleCount: 1,
          samples: [{
            name: 'nyabase_node_cpu_usage_ratio',
            labels: { cpu: '0' },
            value: 0.5,
          }],
          metrics: {},
        },
      })
      .mockRejectedValueOnce({ code: 'NODE_METRICS_TIMEOUT' });
    const db = makeDatabase({
      id: serverId,
      node_metrics_endpoint: 'https://node.example.test/metrics',
      node_metrics_token_ciphertext: 'rfs-v1.cipher.tag',
      node_metrics_status: NodeMetricsStatus.Unknown,
      node_metrics_last_success_at: null,
    });
    const writeBatch = vi.fn().mockResolvedValue(undefined);
    const scraper = service(db.database, pull, writeBatch);

    await scraper.scrapeAll();
    await scraper.scrapeAll();

    expect(writeBatch.mock.calls[0]?.[1]).toEqual([
      expect.objectContaining({
        name: 'nyabase_node_cpu_usage_ratio',
        value: 0.5,
      }),
      expect.objectContaining({
        name: 'nyabase_node_scrape_up',
        value: 1,
      }),
    ]);
    expect(writeBatch.mock.calls[1]?.[1]).toEqual([
      expect.objectContaining({
        name: 'nyabase_node_scrape_up',
        value: 0,
      }),
    ]);
    expect(db.updates).toContainEqual(expect.objectContaining({
      node_metrics_status: NodeMetricsStatus.Unknown,
    }));
  });

  it('keeps a recently successful node online during a transient failure', async () => {
    const pull = vi.fn().mockRejectedValue({ code: 'NODE_METRICS_TIMEOUT' });
    const db = makeDatabase({
      id: serverId,
      node_metrics_endpoint: 'https://node.example.test/metrics',
      node_metrics_token_ciphertext: 'rfs-v1.cipher.tag',
      node_metrics_status: NodeMetricsStatus.Online,
      node_metrics_last_success_at: new Date(Date.now() - 1_000),
    });
    const scraper = service(db.database, pull);

    await scraper.scrapeAll();

    expect(db.updates).toContainEqual(expect.objectContaining({
      node_metrics_status: NodeMetricsStatus.Online,
    }));
  });

  it('ignores a success from an older endpoint and token generation', async () => {
    let releasePull!: (value: unknown) => void;
    const pull = vi.fn().mockImplementation(() => new Promise((resolve) => {
      releasePull = resolve;
    }));
    const current = {
      revision: 5,
      node_metrics_endpoint: 'https://new.example.test/metrics',
      node_metrics_token_ciphertext: 'new-ciphertext',
      node_metrics_token_fingerprint: 'token-fingerprint-b',
      node_metrics_status: NodeMetricsStatus.Unknown,
      node_metrics_last_success_at: null,
    };
    const db = makeDatabase({
      id: serverId,
      revision: 4,
      node_metrics_endpoint: 'https://old.example.test/metrics',
      node_metrics_token_ciphertext: 'old-ciphertext',
      node_metrics_status: NodeMetricsStatus.Unknown,
      node_metrics_last_success_at: null,
    }, current);
    const writeBatch = vi.fn().mockResolvedValue(undefined);
    const scraper = service(db.database, pull, writeBatch);

    const scrape = scraper.scrapeAll();
    await vi.waitFor(() => expect(pull).toHaveBeenCalledTimes(1));
    releasePull({
      status: 'online',
      report: {
        samples: [{
          name: 'nyabase_node_cpu_usage_ratio',
          labels: { cpu: '0' },
          value: 0.5,
        }],
      },
    });
    await scrape;

    expect(writeBatch).not.toHaveBeenCalled();
    expect(db.updates).toHaveLength(0);
  });

  it('rechecks configuration before writing a delayed response to VictoriaMetrics', async () => {
    let releasePull!: (value: unknown) => void;
    const pull = vi.fn().mockImplementation(() => new Promise((resolve) => {
      releasePull = resolve;
    }));
    const oldConfiguration = {
      id: serverId,
      revision: 4,
      node_metrics_endpoint: 'https://old.example.test/metrics',
      node_metrics_token_ciphertext: 'old-ciphertext',
      node_metrics_status: NodeMetricsStatus.Unknown,
      node_metrics_last_success_at: null,
    };
    const newConfiguration = {
      revision: 5,
      node_metrics_endpoint: 'https://new.example.test/metrics',
      node_metrics_token_ciphertext: 'new-ciphertext',
      node_metrics_token_fingerprint: 'token-fingerprint-b',
    };
    const db = makeDatabase(oldConfiguration);
    let checks = 0;
    db.executeTakeFirst.mockImplementation(async () => {
      const current = db.getCurrentServer();
      checks += 1;
      if (checks === 1) {
        queueMicrotask(() => db.setCurrentServer(newConfiguration));
      }
      return current;
    });
    const writeBatch = vi.fn().mockResolvedValue(undefined);
    const scraper = service(db.database, pull, writeBatch);

    const scrape = scraper.scrapeAll();
    await vi.waitFor(() => expect(pull).toHaveBeenCalledTimes(1));
    releasePull({
      status: 'online',
      report: {
        samples: [{
          name: 'nyabase_node_cpu_usage_ratio',
          labels: { cpu: '0' },
          value: 0.5,
        }],
      },
    });
    await scrape;

    expect(checks).toBeGreaterThanOrEqual(2);
    expect(writeBatch).not.toHaveBeenCalled();
    expect(db.updates).toHaveLength(0);
  });

  it('waits for an active persistence projection during shutdown', async () => {
    let releaseWrite!: () => void;
    const writeBatch = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => {
        releaseWrite = resolve;
      }),
    );
    const pull = vi.fn().mockResolvedValue({
      status: 'online',
      report: {
        samples: [{
          name: 'nyabase_node_cpu_usage_ratio',
          labels: { cpu: '0' },
          value: 0.5,
        }],
      },
    });
    const db = makeDatabase({
      id: serverId,
      node_metrics_endpoint: 'https://node.example.test/metrics',
      node_metrics_token_ciphertext: 'rfs-v1.cipher.tag',
      node_metrics_status: NodeMetricsStatus.Unknown,
      node_metrics_last_success_at: null,
    });
    const scraper = service(db.database, pull, writeBatch);
    const scrape = scraper.scrapeAll();
    await vi.waitFor(() => expect(writeBatch).toHaveBeenCalledTimes(1));

    let destroyed = false;
    const shutdown = scraper.onModuleDestroy().then(() => {
      destroyed = true;
    });
    await Promise.resolve();
    expect(destroyed).toBe(false);

    releaseWrite();
    await scrape;
    await shutdown;
    expect(destroyed).toBe(true);
  });

  it('cancels an active pull and waits for its real operation on shutdown', async () => {
    let aborted = false;
    const pull = vi.fn().mockImplementation((
      _serverId: string,
      _endpoint: string,
      _token: string,
      signal?: AbortSignal,
    ) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('pull aborted'));
      }, { once: true });
    }));
    const db = makeDatabase({
      id: serverId,
      node_metrics_endpoint: 'https://node.example.test/metrics',
      node_metrics_token_ciphertext: 'rfs-v1.cipher.tag',
      node_metrics_status: NodeMetricsStatus.Unknown,
      node_metrics_last_success_at: null,
    });
    const scraper = service(db.database, pull, undefined, true);
    const scrape = scraper.scrapeAll();
    await vi.waitFor(() => expect(pull).toHaveBeenCalledTimes(1));

    await scraper.onModuleDestroy();
    await scrape;

    expect(aborted).toBe(true);
  });

  it('recovers after an outage without filling the outage gap with samples', async () => {
    const pull = vi.fn()
      .mockRejectedValueOnce({ code: 'NODE_METRICS_UNREACHABLE' })
      .mockRejectedValueOnce({ code: 'NODE_METRICS_UNREACHABLE' })
      .mockRejectedValueOnce({ code: 'NODE_METRICS_UNREACHABLE' })
      .mockResolvedValueOnce({
        status: 'online',
        report: {
          samples: [{
            name: 'nyabase_node_cpu_usage_ratio',
            labels: { cpu: '0' },
            value: 0.75,
          }],
        },
      });
    const db = makeDatabase({
      id: serverId,
      node_metrics_endpoint: 'https://node.example.test/metrics',
      node_metrics_token_ciphertext: 'rfs-v1.cipher.tag',
      node_metrics_status: NodeMetricsStatus.Unknown,
      node_metrics_last_success_at: null,
    });
    const writeBatch = vi.fn().mockResolvedValue(undefined);
    const scraper = service(db.database, pull, writeBatch);

    await scraper.scrapeAll();
    await scraper.scrapeAll();
    await scraper.scrapeAll();
    await scraper.scrapeAll();

    const statuses = db.updates
      .map((update) => update.node_metrics_status)
      .filter((value): value is string => typeof value === 'string');
    expect(statuses).toEqual([
      NodeMetricsStatus.Unknown,
      NodeMetricsStatus.Unknown,
      NodeMetricsStatus.Unreachable,
      NodeMetricsStatus.Online,
    ]);
    expect(writeBatch.mock.calls[0]?.[1]).toEqual([expect.objectContaining({
      name: 'nyabase_node_scrape_up',
      value: 0,
    })]);
    expect(writeBatch.mock.calls[2]?.[1]).toEqual([expect.objectContaining({
      name: 'nyabase_node_scrape_up',
      value: 0,
    })]);
    expect(writeBatch.mock.calls[3]?.[1]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'nyabase_node_cpu_usage_ratio',
        value: 0.75,
      }),
      expect.objectContaining({
        name: 'nyabase_node_scrape_up',
        value: 1,
      }),
    ]));
    expect(db.updates[3]).toEqual(expect.objectContaining({
      node_metrics_outage_since: null,
      node_metrics_last_error: null,
    }));
    expect(db.whereClauses).toEqual(expect.arrayContaining([
      ['revision', '=', 1],
      ['node_metrics_endpoint', '=', 'https://node.example.test/metrics'],
      ['node_metrics_token_fingerprint', '=', 'token-fingerprint-a'],
    ]));
  });

  it('contains a PostgreSQL rejection during a scheduled scrape', async () => {
    const db = makeDatabase({
      id: serverId,
      node_metrics_endpoint: 'https://node.example.test/metrics',
      node_metrics_token_ciphertext: 'rfs-v1.cipher.tag',
    });
    db.database.selectFrom = vi.fn(() => {
      throw new Error('postgres unavailable');
    });
    const scraper = service(db.database, vi.fn());

    await expect(scraper.scrapeAll()).resolves.toBeUndefined();
  });
});
