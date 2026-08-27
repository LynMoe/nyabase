import { afterEach, describe, expect, it, vi } from 'vitest';
import { MetricsWriter } from './metrics-writer.js';

const serverId = '00000000-0000-4000-8000-000000000001';
const point = {
  name: 'nyabase_node_cpu_usage_ratio',
  labels: { cpu: '0' },
  value: 0.5,
  ts: 1,
};

function makeWriter(fetchMock: ReturnType<typeof vi.fn>): MetricsWriter {
  vi.stubGlobal('fetch', fetchMock);
  return new MetricsWriter({
    get: vi.fn().mockReturnValue('http://vmagent'),
  } as never);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('MetricsWriter lifecycle', () => {
  it('waits for an already-started flush during shutdown', async () => {
    let releaseFetch!: (response: { ok: true }) => void;
    const fetchMock = vi.fn(() => new Promise((resolve) => {
      releaseFetch = resolve;
    }));
    const writer = makeWriter(fetchMock);
    const write = writer.writeBatch(serverId, [point]);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    let destroyed = false;
    const shutdown = writer.onModuleDestroy().then(() => {
      destroyed = true;
    });
    await Promise.resolve();
    expect(destroyed).toBe(false);

    releaseFetch({ ok: true });
    await write;
    await shutdown;
    expect(destroyed).toBe(true);
    expect(writer.getStats()).toMatchObject({ inFlight: 0, dropped: 0 });
  });

  it('records dropped batches and degraded state after a bounded drain timeout', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => new Promise(() => undefined));
    const writer = makeWriter(fetchMock);
    void writer.writeBatch(serverId, [point]);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const shutdown = writer.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(5_000);
    await shutdown;

    expect(writer.getStats()).toMatchObject({
      dropped: 1,
      lastError: expect.stringContaining('shutdown drain timed out'),
    });
  });

  it('rechecks a queued configuration guard before sending the batch', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    const writer = makeWriter(fetchMock);
    const guard = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await writer.writeBatch(serverId, [point], { guard });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(writer.getStats()).toMatchObject({ dropped: 1, queued: 0 });
  });
});
