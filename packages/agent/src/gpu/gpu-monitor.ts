import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import { GpuInfo, MetricPoint } from '@nyabase/common';

const execFileAsync = promisify(execFile);

let probedAvailability: boolean | null = null;

/**
 * One-shot host probe for nvidia-smi. Cached for the lifetime of the process:
 * we never expect GPUs to be hot-plugged into a running agent, and re-running
 * `nvidia-smi --query-gpu=count` every 10s wastes a fork+exec on CPU-only hosts.
 */
export async function probeGpuAvailability(): Promise<boolean> {
  if (probedAvailability !== null) return probedAvailability;
  try {
    await execFileAsync('nvidia-smi', ['--query-gpu=count', '--format=csv,noheader'], { timeout: 3000 });
    probedAvailability = true;
  } catch {
    probedAvailability = false;
  }
  return probedAvailability;
}

/** @internal — exposed for tests. */
export function _resetGpuProbeForTest(): void {
  probedAvailability = null;
}

export interface GpuStats {
  index: number;
  uuid: string;
  utilizationPercent: number;
  memUsedMiB: number;
  memTotalMiB: number;
  temperatureCelsius: number;
  powerWatts: number;
  graphicsClockMHz?: number;
}

export interface GpuProcessInfo {
  pid: number;
  usedMemoryMiB: number;
  gpuUuid: string;
  containerId?: string;
  ownerId?: string;
}

export interface GpuContainerIdentity {
  metricContainerId: string;
  ownerId?: string;
}

export class GpuMonitor {
  /**
   * @param enabled If false, all collection methods short-circuit to empty.
   *                Set from `AgentConfig.isGpuServer`. Independent of the
   *                runtime nvidia-smi probe (see `probeGpuAvailability`).
   */
  constructor(private readonly enabled: boolean = true) {}

  isEnabled(): boolean {
    return this.enabled;
  }

  async getGpuInfo(): Promise<GpuInfo[]> {
    if (!this.enabled) return [];
    try {
      const { stdout } = await execFileAsync('nvidia-smi', [
        '--query-gpu=index,uuid,name,memory.total',
        '--format=csv,noheader,nounits',
      ]);
      return stdout.trim().split('\n').filter(Boolean).map((line) => {
        const [index, uuid, name, totalMemMiB] = line.split(', ').map((s) => s.trim());
        return {
          index: parseInt(index, 10),
          uuid,
          model: name,
          totalMemMiB: parseInt(totalMemMiB, 10),
        };
      });
    } catch {
      return [];
    }
  }

  async getGpuStats(): Promise<GpuStats[]> {
    if (!this.enabled) return [];
    try {
      const { stdout } = await execFileAsync('nvidia-smi', [
        '--query-gpu=index,uuid,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,clocks.gr',
        '--format=csv,noheader,nounits',
      ]);
      return stdout.trim().split('\n').filter(Boolean).map((line) => {
        const [index, uuid, util, memUsed, memTotal, temp, power, graphicsClock] =
          line.split(', ').map((s) => s.trim());
        const graphicsClockMHz = parseNvidiaNonNegativeNumber(graphicsClock);
        return {
          index: parseInt(index, 10),
          uuid,
          utilizationPercent: parseFloat(util),
          memUsedMiB: parseInt(memUsed, 10),
          memTotalMiB: parseInt(memTotal, 10),
          temperatureCelsius: parseFloat(temp),
          powerWatts: parseFloat(power),
          ...(graphicsClockMHz !== undefined && { graphicsClockMHz }),
        };
      });
    } catch {
      return [];
    }
  }

  async getGpuProcesses(): Promise<GpuProcessInfo[]> {
    if (!this.enabled) return [];
    try {
      const { stdout } = await execFileAsync('nvidia-smi', [
        '--query-compute-apps=pid,used_memory,gpu_uuid',
        '--format=csv,noheader,nounits',
      ]);
      const lines = stdout.trim().split('\n').filter(Boolean);
      // Resolve container IDs in parallel (each reads a single /proc/<pid>/cgroup file)
      const processes = await Promise.all(
        lines.map((line): GpuProcessInfo | null => {
          const [pidStr, usedMem, gpuUuid] = line.split(', ').map((s) => s.trim());
          const pid = parseInt(pidStr, 10);
          const usedMemoryMiB = parseNvidiaNonNegativeNumber(usedMem);
          if (!Number.isInteger(pid) || pid <= 0 || usedMemoryMiB === undefined) return null;
          const containerId = this.pidToContainerId(pid);
          return { pid, usedMemoryMiB, gpuUuid, containerId };
        }),
      );
      return processes.filter((p): p is GpuProcessInfo => p !== null);
    } catch {
      return [];
    }
  }

  async getContainerGpuMemUsedMiB(dockerId: string): Promise<Record<string, number>> {
    if (!this.enabled) return {};
    const requestedIds = new Set([dockerId, dockerId.slice(0, 12)].filter(Boolean));
    const usage: Record<string, number> = {};

    try {
      const processes = await this.getGpuProcesses();
      for (const p of processes) {
        if (!p.containerId) continue;
        if (!requestedIds.has(p.containerId) && !requestedIds.has(p.containerId.slice(0, 12))) continue;
        usage[p.gpuUuid] = (usage[p.gpuUuid] ?? 0) + p.usedMemoryMiB;
      }
    } catch {
      return {};
    }

    return usage;
  }

  private pidToContainerId(pid: number): string | undefined {
    try {
      const cgroupPath = `/proc/${pid}/cgroup`;
      if (!fs.existsSync(cgroupPath)) return undefined;
      const content = fs.readFileSync(cgroupPath, 'utf-8');

      // cgroup v2: 0::/system.slice/docker-<id>.scope or 0::/docker/<id>
      const v2match =
        content.match(/0::.*docker-([0-9a-f]{64})\.scope/) ||
        content.match(/0::\/docker\/([0-9a-f]{64})/);
      if (v2match) return v2match[1];

      // cgroup v1 fallback: any controller with /docker/<id>
      const v1match = content.match(/\/docker\/([0-9a-f]{64})/);
      if (v1match) return v1match[1];
    } catch {
      // ignore
    }
    return undefined;
  }

  buildMetrics(
    stats: GpuStats[],
    processes: GpuProcessInfo[],
    containerOwnerMap: Map<string, GpuContainerIdentity>,
    serverId: string,
  ): MetricPoint[] {
    const ts = Date.now();
    const points: MetricPoint[] = [];

    for (const s of stats) {
      points.push({
        name: 'nyabase_gpu_util_ratio',
        labels: { server: serverId, gpu_index: String(s.index) },
        value: s.utilizationPercent / 100,
        ts,
      });
      points.push({
        name: 'nyabase_gpu_mem_used_bytes',
        labels: { server: serverId, gpu_index: String(s.index) },
        value: s.memUsedMiB * 1024 * 1024,
        ts,
      });
      points.push({
        name: 'nyabase_gpu_temp_celsius',
        labels: { server: serverId, gpu_index: String(s.index) },
        value: s.temperatureCelsius,
        ts,
      });
      points.push({
        name: 'nyabase_gpu_power_watts',
        labels: { server: serverId, gpu_index: String(s.index) },
        value: s.powerWatts,
        ts,
      });
      if (s.graphicsClockMHz !== undefined && Number.isFinite(s.graphicsClockMHz) && s.graphicsClockMHz >= 0) {
        points.push({
          name: 'nyabase_gpu_clock_graphics_mhz',
          labels: { server: serverId, gpu_index: String(s.index) },
          value: s.graphicsClockMHz,
          ts,
        });
      }
    }

    for (const p of processes) {
      const owner = p.containerId ? containerOwnerMap.get(p.containerId) : undefined;
      if (!owner) continue;
      points.push({
        name: 'nyabase_gpu_proc_mem_used_bytes',
        labels: {
          server: serverId,
          gpu_uuid: p.gpuUuid,
          container_id: owner.metricContainerId,
          user_id: owner.ownerId ?? '',
        },
        value: p.usedMemoryMiB * 1024 * 1024,
        ts,
      });
    }

    return points;
  }
}

function parseNvidiaNonNegativeNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'N/A' || trimmed.toLowerCase().includes('unknown')) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
