import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { MetricSeries } from '@nyabase/common';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';

interface VmRangeResult {
  metric: Record<string, string>;
  values: [number, string][];
}

@Injectable()
export class MetricsQueryService {
  private readonly vmUrl: string;
  private readonly logger = new Logger(MetricsQueryService.name);

  constructor(config: NyabaseConfigService) {
    this.vmUrl = config.get<string>('metrics.victoriaMetricsUrl');
  }

  /** Query a time range; returns one Series per label combination, keyed by `keyLabel`. */
  async queryRange(
    promql: string,
    start: number,
    end: number,
    step: number,
  ): Promise<Array<{ metric: Record<string, string>; series: MetricSeries }>> {
    const params = new URLSearchParams({
      query: promql,
      start: String(start),
      end: String(end),
      step: String(step),
    });

    const raw = await this.vmFetch(`${this.vmUrl}/api/v1/query_range?${params}`);
    if (!raw || (raw as Record<string, unknown>).status !== 'success') return [];

    const results: VmRangeResult[] = ((raw as Record<string, unknown>).data as Record<string, unknown>)?.result as VmRangeResult[] ?? [];
    return results.map((r) => ({
      metric: r.metric,
      series: {
        step,
        points: r.values.map(([t, v]) => ({ t, v: v === null ? null : parseFloat(v) })),
      },
    }));
  }

  /** Convenience: query range and return the first series's values keyed by a label. */
  async queryRangeByLabel(
    promql: string,
    start: number,
    end: number,
    step: number,
    labelKey: string,
  ): Promise<Map<string, MetricSeries>> {
    const results = await this.queryRange(promql, start, end, step);
    const map = new Map<string, MetricSeries>();
    for (const { metric, series } of results) {
      const key = metric[labelKey] ?? '__unknown__';
      if (!map.has(key)) {
        map.set(key, series);
      } else {
        // Merge: take whichever has more data points
        const existing = map.get(key)!;
        if (series.points.length > existing.points.length) map.set(key, series);
      }
    }
    return map;
  }

  /** Return first matching series or an empty series. */
  async queryRangeSingle(
    promql: string,
    start: number,
    end: number,
    step: number,
  ): Promise<MetricSeries> {
    const results = await this.queryRange(promql, start, end, step);
    return results[0]?.series ?? emptySeries(step);
  }

  private async vmFetch(url: string): Promise<unknown> {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) {
        this.logger.warn(`VictoriaMetrics ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
        return null;
      }
      return res.json();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('timeout') || msg.includes('ECONNREFUSED')) {
        throw new ServiceUnavailableException('Metrics service unavailable');
      }
      this.logger.warn(`VM fetch error: ${msg}`);
      return null;
    }
  }
}

export function emptySeries(step: number): MetricSeries {
  return { step, points: [] };
}

/** Parse ?range=1h|6h|24h into { start, end, step } in unix seconds. */
export function parseRange(range = '1h'): { start: number; end: number; step: number } {
  const end = Math.floor(Date.now() / 60_000) * 60;
  const durations: Record<string, number> = { '1h': 3600, '6h': 21600, '24h': 86400 };
  const duration = durations[range] ?? 3600;
  const steps: Record<string, number> = { '1h': 60, '6h': 300, '24h': 600 };
  const step = steps[range] ?? 60;
  return { start: end - duration, end, step };
}
