import { execFile as childExecFile } from 'node:child_process';
import { readFile as fsReadFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { NodeMetricSample } from '@nyabase/common';
import {
  NVIDIA_GPU_DRIVER_PRESENT_METRIC,
  NVIDIA_GPU_TOOLKIT_PRESENT_METRIC,
} from '../metrics.js';
import { canonicalPciAddress } from '../pci.js';

const execFile = promisify(childExecFile);
const COMMAND_TIMEOUT_MS = 1_000;
const COMMAND_MAX_BUFFER_BYTES = 256 * 1024;
const BYTES_PER_MIB = 1024 * 1024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ReadOnlyNodeFileSystem {
  readFile(path: string): Promise<string>;
}

export interface ReadOnlyCommandOptions {
  readonly timeout: number;
  readonly maxBuffer: number;
}

export type ReadOnlyCommand = (
  file: string,
  args: readonly string[],
  options: ReadOnlyCommandOptions,
) => Promise<{ readonly stdout: string; readonly stderr?: string }>;

export interface NvidiaGpuCollectorOptions {
  readonly fileSystem?: ReadOnlyNodeFileSystem;
  readonly command?: ReadOnlyCommand;
}

export interface GpuMetricRecord {
  readonly index: number;
  readonly pci: string;
  readonly uuid: string;
  readonly utilizationRatio?: number;
  readonly memoryUsedBytes?: number;
  readonly memoryTotalBytes?: number;
  readonly temperatureCelsius?: number;
  readonly powerWatts?: number;
}

export interface GpuProcessMetricRecord {
  readonly gpuUuid: string;
  readonly memoryUsedBytes: number;
  readonly containerId: string;
}

const defaultFileSystem: ReadOnlyNodeFileSystem = {
  readFile: (path) => fsReadFile(path, 'utf8'),
};

const defaultCommand: ReadOnlyCommand = async (file, args, options) => {
  try {
    const result = await execFile(file, [...args], {
      timeout: options.timeout,
      maxBuffer: options.maxBuffer,
      windowsHide: true,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const commandError = error as { stdout?: unknown; stderr?: unknown };
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      stdout: typeof commandError.stdout === 'string' ? commandError.stdout : '',
      stderr: typeof commandError.stderr === 'string' ? commandError.stderr : '',
    });
  }
};

function commandOptions(): ReadOnlyCommandOptions {
  return { timeout: COMMAND_TIMEOUT_MS, maxBuffer: COMMAND_MAX_BUFFER_BYTES };
}

async function commandSucceeds(
  command: ReadOnlyCommand,
  file: string,
  args: readonly string[],
): Promise<boolean> {
  try {
    await command(file, args, commandOptions());
    return true;
  } catch {
    return false;
  }
}

/** Catch-all: missing nvidia-smi must not crash the exporter. */
export async function collectNvidiaGpuMetrics(
  options: NvidiaGpuCollectorOptions = {},
): Promise<NodeMetricSample[]> {
  const fileSystem = options.fileSystem ?? defaultFileSystem;
  const command = options.command ?? defaultCommand;
  const samples: NodeMetricSample[] = [];
  let gpuStdout: string | undefined;
  try {
    ({ stdout: gpuStdout } = await command(
      'nvidia-smi',
      [
        '--query-gpu=index,pci.bus_id,uuid,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw',
        '--format=csv,noheader,nounits',
      ],
      commandOptions(),
    ));
  } catch {
    gpuStdout = undefined;
  }
  const toolkitPresent = await commandSucceeds(command, 'nvidia-container-cli', ['--version'])
    || await commandSucceeds(command, 'nvidia-container-runtime', ['--version']);
  samples.push({
    name: NVIDIA_GPU_DRIVER_PRESENT_METRIC,
    labels: {},
    value: gpuStdout === undefined ? 0 : 1,
  });
  samples.push({
    name: NVIDIA_GPU_TOOLKIT_PRESENT_METRIC,
    labels: {},
    value: toolkitPresent ? 1 : 0,
  });
  if (gpuStdout === undefined) return samples;
  const gpus = parseGpuStats(gpuStdout);
  if (gpus.length === 0) return samples;
  for (const gpu of gpus) {
    const labels = { gpu_pci: gpu.pci };
    addSample(samples, 'nyabase_node_gpu_smi_index', labels, gpu.index);
    addSample(samples, 'nyabase_node_gpu_util_ratio', labels, gpu.utilizationRatio);
    addSample(samples, 'nyabase_node_gpu_mem_used_bytes', labels, gpu.memoryUsedBytes);
    addSample(samples, 'nyabase_node_gpu_mem_total_bytes', labels, gpu.memoryTotalBytes);
    addSample(samples, 'nyabase_node_gpu_temperature_celsius', labels, gpu.temperatureCelsius);
    addSample(samples, 'nyabase_node_gpu_power_watts', labels, gpu.powerWatts);
  }
  samples.push(...await collectGpuProcessMetrics(gpus, fileSystem, command));
  return samples;
}

async function collectGpuProcessMetrics(
  gpus: readonly GpuMetricRecord[],
  fileSystem: ReadOnlyNodeFileSystem,
  command: ReadOnlyCommand,
): Promise<NodeMetricSample[]> {
  let stdout: string;
  try {
    ({ stdout } = await command(
      'nvidia-smi',
      [
        '--query-compute-apps=pid,used_memory,gpu_uuid',
        '--format=csv,noheader,nounits',
      ],
      commandOptions(),
    ));
  } catch {
    return [];
  }
  const processes: GpuProcessMetricRecord[] = [];
  for (const line of stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    const fields = line.split(',').map((value) => value.trim());
    const pid = Number(fields[0]);
    const memoryMiB = Number(fields[1]);
    const gpuUuid = fields[2] ?? '';
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isFinite(memoryMiB) || memoryMiB < 0) {
      continue;
    }
    processes.push({
      gpuUuid,
      memoryUsedBytes: memoryMiB * BYTES_PER_MIB,
      containerId: await pidContainerId(fileSystem, pid),
    });
  }
  return joinGpuProcesses(gpus, processes).map((process) => ({
    name: 'nyabase_node_gpu_process_mem_used_bytes',
    labels: {
      gpu_pci: process.pci,
      container_id: process.containerId,
    },
    value: process.memoryUsedBytes,
  }));
}

async function pidContainerId(fileSystem: ReadOnlyNodeFileSystem, pid: number): Promise<string> {
  try {
    const content = await fileSystem.readFile(`/proc/${pid}/cgroup`);
    const match = content.match(
      /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i,
    );
    if (match && UUID_PATTERN.test(match[0])) return match[0].toLowerCase();
  } catch {
    // A process can disappear between nvidia-smi and the cgroup read.
  }
  return '__unattributed__';
}

export function parseGpuStats(content: string): GpuMetricRecord[] {
  const gpus: GpuMetricRecord[] = [];
  for (const line of content.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    const fields = line.split(',').map((value) => value.trim());
    const index = Number(fields[0]);
    const pci = fields[1] ? canonicalPciAddress(fields[1]) : null;
    const uuid = fields[2] ?? '';
    if (!Number.isInteger(index) || index < 0 || !pci || uuid.length === 0) continue;
    gpus.push({
      index,
      pci,
      uuid,
      utilizationRatio: boundedPercent(fields[3]),
      memoryUsedBytes: mibBytes(fields[4]),
      memoryTotalBytes: mibBytes(fields[5]),
      temperatureCelsius: nonNegativeNumber(fields[6]),
      powerWatts: nonNegativeNumber(fields[7]),
    });
  }
  return gpus;
}

export function joinGpuProcesses(
  gpus: readonly GpuMetricRecord[],
  processes: readonly GpuProcessMetricRecord[],
): Array<GpuProcessMetricRecord & { readonly pci: string }> {
  const pciByUuid = new Map(
    gpus.flatMap((gpu) => {
      const pci = canonicalPciAddress(gpu.pci);
      return pci ? [[gpu.uuid, pci] as const] : [];
    }),
  );
  const totals = new Map<string, GpuProcessMetricRecord & { pci: string }>();
  for (const process of processes) {
    const pci = pciByUuid.get(process.gpuUuid);
    if (!pci) continue;
    const key = `${pci}\0${process.containerId}`;
    const current = totals.get(key);
    if (current) {
      totals.set(key, {
        ...current,
        memoryUsedBytes: current.memoryUsedBytes + process.memoryUsedBytes,
      });
    } else {
      totals.set(key, { ...process, pci });
    }
  }
  return [...totals.values()];
}

function addSample(
  samples: NodeMetricSample[],
  name: NodeMetricSample['name'],
  labels: Readonly<Record<string, string>>,
  value: number | undefined,
): void {
  if (value !== undefined) samples.push({ name, labels, value });
}

function boundedPercent(value: string | undefined): number | undefined {
  const parsed = nonNegativeNumber(value);
  return parsed === undefined || parsed > 100 ? undefined : parsed / 100;
}

function mibBytes(value: string | undefined): number | undefined {
  const parsed = nonNegativeNumber(value);
  return parsed === undefined ? undefined : parsed * BYTES_PER_MIB;
}

function nonNegativeNumber(value: string | undefined): number | undefined {
  if (!value || value === 'N/A' || /unknown/i.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
