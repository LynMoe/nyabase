import type { HttpProxyBindingCounters } from '@nyabase/common';

/** Rates are averaged over at least this much of a proxy's report history. */
export const HTTP_PROXY_RATE_WINDOW_MS = 5_000;
/** A connected proxy whose latest report is older than this contributes nothing live. */
export const HTTP_PROXY_LIVE_SAMPLE_MAX_AGE_MS = 15_000;
const MAX_SAMPLES_PER_CONNECTION = 64;

export type BindingCounterValues = Omit<HttpProxyBindingCounters, 'bindingId'>;

export interface LiveBindingTraffic {
  activeConnections: number;
  rxBytesPerSec: number | null;
  txBytesPerSec: number | null;
}

interface Sample {
  at: number;
  bindings: ReadonlyMap<string, BindingCounterValues>;
}

interface ConnectionTraffic {
  instanceKey: string | null;
  samples: Sample[];
}

export function countersByBinding(
  bindings: readonly HttpProxyBindingCounters[] | undefined,
): Map<string, BindingCounterValues> {
  const result = new Map<string, BindingCounterValues>();
  for (const { bindingId, ...values } of bindings ?? []) result.set(bindingId, values);
  return result;
}

/**
 * The live half of the per-binding traffic statistics: the recent reports of
 * each connected proxy, kept only in memory. A disconnected proxy is
 * forgotten at once and contributes nothing.
 */
export class HttpProxyLiveTraffic {
  private readonly connections = new Map<object, ConnectionTraffic>();

  record(
    connection: object,
    instanceKey: string | null,
    bindings: ReadonlyMap<string, BindingCounterValues>,
    at: number,
  ): void {
    let traffic = this.connections.get(connection);
    if (!traffic || traffic.instanceKey !== instanceKey) {
      traffic = { instanceKey, samples: [] };
      this.connections.set(connection, traffic);
    }
    const samples = traffic.samples;
    if (samples.length > 0 && at <= samples[samples.length - 1]!.at) samples.length = 0;
    samples.push({ at, bindings });
    // Keep the newest sample that is at least a window old as the baseline.
    while (
      samples.length > 2
      && (samples[1]!.at <= at - HTTP_PROXY_RATE_WINDOW_MS || samples.length > MAX_SAMPLES_PER_CONNECTION)
    ) {
      samples.shift();
    }
  }

  forget(connection: object): void {
    this.connections.delete(connection);
  }

  live(bindingIds: readonly string[], now: number): Map<string, LiveBindingTraffic> {
    const result = new Map<string, LiveBindingTraffic>(bindingIds.map((id) => [id, {
      activeConnections: 0,
      rxBytesPerSec: null,
      txBytesPerSec: null,
    }]));
    for (const { samples } of this.connections.values()) {
      const latest = samples[samples.length - 1];
      if (!latest || latest.at < now - HTTP_PROXY_LIVE_SAMPLE_MAX_AGE_MS) continue;
      const baseline = samples.length > 1 ? samples[0]! : null;
      const seconds = baseline ? (latest.at - baseline.at) / 1_000 : 0;
      for (const [bindingId, live] of result) {
        const current = latest.bindings.get(bindingId);
        live.activeConnections += current?.activeConnections ?? 0;
        if (!baseline || seconds <= 0) continue;
        const before = baseline.bindings.get(bindingId);
        // A binding missing from either report moved nothing we can measure.
        const moved = current && before
          ? {
            rx: Math.max(0, current.rxBytes - before.rxBytes),
            tx: Math.max(0, current.txBytes - before.txBytes),
          }
          : { rx: 0, tx: 0 };
        live.rxBytesPerSec = (live.rxBytesPerSec ?? 0) + moved.rx / seconds;
        live.txBytesPerSec = (live.txBytesPerSec ?? 0) + moved.tx / seconds;
      }
    }
    for (const live of result.values()) {
      if (live.rxBytesPerSec !== null) live.rxBytesPerSec = Math.round(live.rxBytesPerSec);
      if (live.txBytesPerSec !== null) live.txBytesPerSec = Math.round(live.txBytesPerSec);
    }
    return result;
  }
}
