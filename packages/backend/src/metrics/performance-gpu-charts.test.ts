import { describe, expect, it } from 'vitest';
import { gpuCardCharts } from './performance-gpu-charts.js';
import type { InventoryContainer } from './performance-model.js';

const serverId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const pci = '00000000:81:00.0';
const ada = { id: '11111111-1111-4111-8111-111111111111', ownerId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', displayName: 'Ada' };
const bob = { id: '22222222-2222-4222-8222-222222222222', ownerId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', displayName: 'Bob' };
const eve = { id: '33333333-3333-4333-8333-333333333333', ownerId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', displayName: 'Eve' };

function container(fields: { id: string; ownerId: string; displayName: string }): InventoryContainer {
  return {
    ...fields,
    serverId,
    serverName: 'lab',
    username: fields.displayName.toLowerCase(),
    name: `${fields.displayName.toLowerCase()}-box`,
    lifecyclePhase: 'active',
    powerIntent: 'running',
    cpuSet: [0],
    createdAt: 0,
    pciAddresses: [pci],
    volumes: [],
  };
}

type Point = { ts: number; labels: Record<string, string>; value: number };
const at = (containerId: string, ts: number, value: number): Point => ({ ts, labels: { container_id: containerId, gpu_pci: pci }, value });

describe('gpuCardCharts', () => {
  const series = new Map<string, Point[]>([
    ['gpu_process_bytes', [at(ada.id, 1_000, 10), at(ada.id, 2_000, 10), at(bob.id, 2_000, 5)]],
    ['gpu_process_sm', [at(ada.id, 1_000, 0.2), at(ada.id, 2_000, 0.3), at(bob.id, 2_000, 0.6)]],
    ['gpu_process_mem_bw', [at(ada.id, 2_000, 0.1), at(bob.id, 2_000, 0.4)]],
  ]);
  const containers = [container(ada), container(bob), container(eve)];

  it('gives each card memory and utilization lines for the same people, idle ones dropped', () => {
    const [card] = gpuCardCharts({ containers, series, timeline: [1_000, 2_000] }, [{ pci, index: 0, totalBytes: 80 }]);
    expect(card?.lines.map((line) => line.label)).toEqual(['Ada', 'Bob']);
    expect(card?.utilization.sm.map((line) => [line.label, line.points.map((point) => point.v)])).toEqual([
      ['Bob', [0, 0.6]],
      ['Ada', [0.2, 0.3]],
    ]);
    expect(card?.utilization.memoryBandwidth.map((line) => [line.key, line.points.map((point) => point.v)])).toEqual([
      [bob.ownerId, [0, 0.4]],
      [ada.ownerId, [0, 0.1]],
    ]);
    expect(card?.utilization.otherCount).toBe(0);
  });

  it('lists whoever holds memory on the utilization chart, at 0% too, and no one else', () => {
    const idleHolder = new Map<string, Point[]>([
      ['gpu_process_bytes', [at(ada.id, 1_000, 10), at(ada.id, 2_000, 10)]],
      ['gpu_process_sm', [at(ada.id, 1_000, 0), at(ada.id, 2_000, 0), at(bob.id, 2_000, 0.5)]],
      ['gpu_process_mem_bw', [at(ada.id, 1_000, 0), at(ada.id, 2_000, 0), at(bob.id, 2_000, 0.2)]],
    ]);
    const [card] = gpuCardCharts({ containers, series: idleHolder, timeline: [1_000, 2_000] }, [{ pci, index: 0, totalBytes: 80 }]);
    expect(card?.lines.map((line) => line.label)).toEqual(['Ada']);
    expect(card?.utilization.sm.map((line) => [line.label, line.points.map((point) => point.v)])).toEqual([['Ada', [0, 0]]]);
    expect(card?.utilization.memoryBandwidth.map((line) => [line.label, line.points.map((point) => point.v)])).toEqual([['Ada', [0, 0]]]);
  });

  it('keeps the requested container even while it is idle', () => {
    const [card] = gpuCardCharts(
      { containers, series, containerId: eve.id, timeline: [1_000, 2_000] },
      [{ pci, index: 0, totalBytes: 80 }],
    );
    expect(card?.lines.map((line) => line.key)).toEqual([eve.id]);
    expect(card?.utilization.sm.map((line) => line.points.map((point) => point.v))).toEqual([[0, 0]]);
  });

  it('charts a busy server over 6h without rescanning every sample per point', () => {
    // 14 containers, 8 cards, 361 one-minute steps: ~130k samples, the size of a
    // full A800 host. A per-point scan of each family took ~15 s here and froze
    // the event loop (every in-flight timer, VictoriaMetrics fetches included,
    // then fired as a timeout).
    const timeline = Array.from({ length: 361 }, (_, step) => step * 60_000);
    const cards = Array.from({ length: 8 }, (_, index) => ({ pci: `00000000:${(0x18 + index * 0x10).toString(16)}:00.0`, index, totalBytes: 80 }));
    const busy = Array.from({ length: 14 }, (_, index) => ({
      ...container({ id: `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`, ownerId: `${String(index).padStart(8, '0')}-2222-4222-8222-222222222222`, displayName: `u${index}` }),
      pciAddresses: cards.map((card) => card.pci),
    }));
    const families = new Map<string, Point[]>();
    for (const family of ['gpu_process_bytes', 'gpu_process_sm', 'gpu_process_mem_bw']) {
      families.set(family, busy.flatMap((item) => cards.flatMap((card) => timeline.map((ts) => (
        { ts, labels: { container_id: item.id, gpu_pci: card.pci, pid: '1' }, value: 1 }
      )))));
    }
    const started = performance.now();
    const charts = gpuCardCharts({ containers: busy, series: families, timeline }, cards);
    expect(performance.now() - started).toBeLessThan(1_500);
    expect(charts).toHaveLength(8);
    expect(charts[0]?.lines.at(-1)?.points.at(-1)?.v).toBe(busy.length - 8);
  });
});
