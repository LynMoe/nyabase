import { afterEach, describe, expect, it, vi } from 'vitest';
import { MetricsWriter } from './metrics-writer.js';
import type { NyabaseConfigService } from '../config/nyabase-config.service.js';
import { MAX_METRIC_POINTS_PER_BATCH } from '@nyabase/common';

function makeWriter(fetchMock: ReturnType<typeof vi.fn>): MetricsWriter {
  vi.stubGlobal('fetch', fetchMock);
  return new MetricsWriter(
    { get: vi.fn().mockReturnValue('http://vmagent') } as unknown as NyabaseConfigService,
  );
}

describe('MetricsWriter vmagent ingestion', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('forwards already-validated stable identities without database normalization', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: vi.fn() });
    const writer = makeWriter(fetchMock);

    await writer.writeBatch('srv-1', [
      {
        name: 'nyabase_user_disk_used_bytes',
        labels: { server: 'srv-1', user_id: '1001' },
        value: 123,
        ts: 1,
      },
      {
        name: 'nyabase_container_mem_used_bytes',
        labels: { server: 'srv-1', container_id: 'container-a' },
        value: 456,
        ts: 1,
      },
    ]);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await writer.onModuleDestroy();

    const body = fetchMock.mock.calls[0][1].body as string;
    expect(fetchMock.mock.calls[0][0]).toBe('http://vmagent/api/v1/import/prometheus');
    expect(body).toContain('nyabase_user_disk_used_bytes{server="srv-1",user_id="1001"} 123 1');
    expect(body).toContain(
      'nyabase_container_mem_used_bytes{server="srv-1",container_id="container-a"} 456 1',
    );
  });

  it('bounds queued points even when the metrics sink cannot flush', async () => {
    const writer = makeWriter(vi.fn().mockResolvedValue({ ok: true, text: vi.fn() }));
    (writer as unknown as { maxConcurrentFlushes: number }).maxConcurrentFlushes = 0;
    const point = {
      name: 'nyabase_host_cpu_usage_ratio' as const,
      labels: { server: 'srv-1' },
      value: 1,
      ts: 1,
    };

    for (let index = 0; index < 5; index += 1) {
      await writer.writeBatch(
        'srv-1',
        Array.from({ length: MAX_METRIC_POINTS_PER_BATCH }, () => point),
      );
    }

    expect(writer.getStats()).toMatchObject({
      queued: 4,
      queuedPoints: MAX_METRIC_POINTS_PER_BATCH * 4,
      dropped: 1,
      inFlight: 0,
    });
    (writer as unknown as { maxConcurrentFlushes: number }).maxConcurrentFlushes = 1;
    await writer.onModuleDestroy();
  });

  it('rejects an over-limit direct batch before identity lookups', async () => {
    const writer = makeWriter(vi.fn().mockResolvedValue({ ok: true, text: vi.fn() }));
    const point = {
      name: 'nyabase_host_cpu_usage_ratio' as const,
      labels: { server: 'srv-1' },
      value: 1,
      ts: 1,
    };

    await writer.writeBatch(
      'srv-1',
      Array.from({ length: MAX_METRIC_POINTS_PER_BATCH + 1 }, () => point),
    );

    expect(writer.getStats()).toMatchObject({ queued: 0, queuedPoints: 0, dropped: 1 });
    await writer.onModuleDestroy();
  });

  it('drops a failed vmagent request without retrying it in the application', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('vmagent unavailable'));
    const writer = makeWriter(fetchMock);

    await writer.writeBatch('srv-1', [
      {
        name: 'nyabase_host_cpu_usage_ratio',
        labels: { server: 'srv-1' },
        value: 1,
        ts: 1,
      },
    ]);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(writer.getStats().inFlight).toBe(0));
    expect(writer.getStats()).toMatchObject({
      queued: 0,
      dropped: 1,
      lastError: expect.stringContaining('vmagent unavailable'),
    });
    await writer.onModuleDestroy();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('backs off after vmagent failure instead of accumulating DNS work', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('vmagent DNS unavailable'))
      .mockResolvedValue({ ok: true, text: vi.fn() });
    const writer = makeWriter(fetchMock);
    const point = {
      name: 'nyabase_host_cpu_usage_ratio' as const,
      labels: { server: 'srv-1' },
      value: 1,
      ts: 1,
    };

    await writer.writeBatch('srv-1', [point]);
    await vi.waitFor(() => expect(writer.getStats().inFlight).toBe(0));
    await writer.writeBatch('srv-1', [point]);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(writer.getStats()).toMatchObject({
      queued: 1,
      dropped: 1,
      lastError: expect.stringContaining('vmagent DNS unavailable'),
    });

    const internals = writer as unknown as {
      retryNotBeforeMonotonic: number;
      flushLoop: () => Promise<void>;
    };
    internals.retryNotBeforeMonotonic = 0;
    await internals.flushLoop();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(writer.getStats().inFlight).toBe(0));
    expect(writer.getStats()).toMatchObject({
      queued: 0,
      dropped: 1,
      lastError: null,
    });
    await writer.onModuleDestroy();
  });

  it('uses monotonic backoff across forward and backward wall-clock jumps', async () => {
    let monotonicNow = 1_000;
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('vmagent unavailable'))
      .mockResolvedValue({ ok: true, text: vi.fn() });
    const writer = makeWriter(fetchMock);
    const internals = writer as unknown as {
      monotonicNowMs: () => number;
      flushLoop: () => Promise<void>;
    };
    internals.monotonicNowMs = () => monotonicNow;
    const wallClock = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    const point = {
      name: 'nyabase_host_cpu_usage_ratio' as const,
      labels: { server: 'srv-1' },
      value: 1,
      ts: 1,
    };

    await writer.writeBatch('srv-1', [point]);
    await vi.waitFor(() => expect(writer.getStats().inFlight).toBe(0));
    await writer.writeBatch('srv-1', [point]);

    // Stay inside ECMAScript's valid Date range so Nest's logger can still
    // format timestamps if the assertion fails.
    wallClock.mockReturnValue(8_000_000_000_000_000);
    await internals.flushLoop();
    expect(fetchMock).toHaveBeenCalledOnce();

    monotonicNow += 10_000;
    wallClock.mockReturnValue(-8_000_000_000_000_000);
    await internals.flushLoop();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(writer.getStats().inFlight).toBe(0));
    await writer.onModuleDestroy();
  });

  it('uses a monotonic shutdown deadline despite forward and backward wall-clock jumps', async () => {
    vi.useFakeTimers();
    try {
      let monotonicNow = 2_000;
      const writer = makeWriter(vi.fn().mockResolvedValue({ ok: true, text: vi.fn() }));
      const internals = writer as unknown as {
        maxConcurrentFlushes: number;
        monotonicNowMs: () => number;
      };
      internals.maxConcurrentFlushes = 0;
      internals.monotonicNowMs = () => monotonicNow;
      const wallClock = vi.spyOn(Date, 'now')
        .mockReturnValue(8_000_000_000_000_000);
      await writer.writeBatch('srv-1', [{
        name: 'nyabase_host_cpu_usage_ratio',
        labels: { server: 'srv-1' },
        value: 1,
        ts: 1,
      }]);

      let drained = false;
      const shutdown = writer.onModuleDestroy().then(() => {
        drained = true;
      });
      await Promise.resolve();
      expect(drained).toBe(false);

      wallClock.mockReturnValue(-8_000_000_000_000_000);
      monotonicNow += 5_001;
      await vi.advanceTimersByTimeAsync(50);
      await shutdown;
      expect(drained).toBe(true);
      expect(writer.getStats().queued).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not await a slow vmagent request on the Agent ingestion path', async () => {
    let resolveFetch!: (response: { ok: true; text: ReturnType<typeof vi.fn> }) => void;
    const fetchMock = vi.fn(() => new Promise((resolve) => {
      resolveFetch = resolve;
    }));
    const writer = makeWriter(fetchMock);

    await expect(writer.writeBatch('srv-1', [
      {
        name: 'nyabase_host_cpu_usage_ratio',
        labels: { server: 'srv-1' },
        value: 1,
        ts: 1,
      },
    ])).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(writer.getStats()).toMatchObject({ queued: 0, inFlight: 1 });

    resolveFetch({ ok: true, text: vi.fn() });
    await vi.waitFor(() => expect(writer.getStats().inFlight).toBe(0));
    await writer.onModuleDestroy();
  });

  it('rejects direct calls with unbounded names or label identities', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: vi.fn() });
    const writer = makeWriter(fetchMock);
    await writer.writeBatch('srv-1', [{
      name: 'syntactically_valid_but_unbounded' as never,
      labels: { server: 'srv-1', source: 'quote"\\line\nnext' },
      value: 1,
      ts: 1,
    }]);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(writer.getStats()).toMatchObject({ queued: 0, dropped: 1 });
    await writer.onModuleDestroy();
  });
});
