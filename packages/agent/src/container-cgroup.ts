import { hyphenateContainerHex, type NodeMetricSample } from '@nyabase/common';
import type { ExtraMetricCollector, ReadOnlyNodeFileSystem } from './collector.js';

const CGROUP_ROOT = '/sys/fs/cgroup';
const MAX_DEPTH = 6;
const MAX_DIRECTORIES = 4096;
const MAX_CONTAINERS = 512;
const PAYLOAD_PATTERN = /^lxc\.payload\.nyc-([0-9a-f]{32})$/i;
const SCOPE_PATTERN = /^incus-(?:[A-Za-z0-9][A-Za-z0-9._-]*-)?nyc-([0-9a-f]{32})\.scope$/i;

interface WalkState {
  visited: number;
  payloads: Map<string, string>;
  scopes: Map<string, string>;
  stopped: boolean;
}

export const collectContainerCgroupMetrics: ExtraMetricCollector = async ({ fileSystem }) => {
  let rootEntries: string[];
  try {
    rootEntries = await fileSystem.readdir(CGROUP_ROOT);
  } catch {
    return [];
  }
  const state: WalkState = {
    visited: 1,
    payloads: new Map(),
    scopes: new Map(),
    stopped: false,
  };
  await walkChildren(fileSystem, CGROUP_ROOT, rootEntries, 1, state);
  const chosen = new Map<string, string>();
  for (const [id, path] of state.payloads) chosen.set(id, path);
  for (const [id, path] of state.scopes) {
    if (!chosen.has(id)) chosen.set(id, path);
  }
  const ordered = [...chosen.keys()].sort();
  const kept = ordered.slice(0, MAX_CONTAINERS);
  const truncated = state.stopped || ordered.length > MAX_CONTAINERS;
  const samples: NodeMetricSample[] = [];
  let observed = 0;
  for (const id of kept) {
    const path = chosen.get(id);
    if (!path) continue;
    const before = samples.length;
    samples.push(...await readContainer(fileSystem, path, id));
    if (samples.length > before) observed += 1;
  }
  samples.push(
    { name: 'nyabase_container_cgroup_observed', labels: {}, value: observed },
    { name: 'nyabase_container_cgroup_truncated', labels: {}, value: truncated ? 1 : 0 },
  );
  return samples;
};

async function walkChildren(
  fileSystem: ReadOnlyNodeFileSystem,
  parent: string,
  names: readonly string[],
  depth: number,
  state: WalkState,
): Promise<void> {
  if (state.stopped) return;
  if (depth > MAX_DEPTH) {
    if (names.length > 0) state.stopped = true;
    return;
  }
  for (const name of names) {
    if (state.stopped || state.visited >= MAX_DIRECTORIES) {
      state.stopped = true;
      return;
    }
    if (name.startsWith('.') || name.startsWith('lxc.monitor.')) continue;
    const path = `${parent}/${name}`;
    const payload = PAYLOAD_PATTERN.exec(name);
    const scope = SCOPE_PATTERN.exec(name);
    if (payload) {
      const id = hyphenateContainerHex(payload[1] ?? '');
      if (id && !state.payloads.has(id)) state.payloads.set(id, path);
      continue;
    }
    if (scope) {
      const id = hyphenateContainerHex(scope[1] ?? '');
      if (id && !state.scopes.has(id)) state.scopes.set(id, path);
    }
    let children: string[];
    try {
      children = await fileSystem.readdir(path);
    } catch {
      continue;
    }
    state.visited += 1;
    await walkChildren(fileSystem, path, children, depth + 1, state);
  }
}

async function readContainer(
  fileSystem: ReadOnlyNodeFileSystem,
  directory: string,
  containerId: string,
): Promise<NodeMetricSample[]> {
  const labels = { container_id: containerId };
  const samples: NodeMetricSample[] = [];
  const cpuStat = await readOptional(fileSystem, `${directory}/cpu.stat`);
  const usage = cpuStat === null ? null : usageSeconds(cpuStat);
  if (usage !== null) {
    samples.push({ name: 'nyabase_container_cpu_usage_seconds_total', labels, value: usage });
  }
  const cpuMax = await readOptional(fileSystem, `${directory}/cpu.max`);
  if (cpuMax !== null) {
    const limit = await kernelCpuLimit(fileSystem, directory, cpuMax);
    if (limit !== null) {
      samples.push({ name: 'nyabase_container_cpu_limit_cores', labels, value: limit });
    }
  }
  const memoryCurrent = await readOptional(fileSystem, `${directory}/memory.current`);
  const used = memoryCurrent === null ? null : wholeBytes(memoryCurrent);
  if (used !== null) {
    samples.push({ name: 'nyabase_container_mem_used_bytes', labels, value: used });
  }
  const memoryMax = await readOptional(fileSystem, `${directory}/memory.max`);
  if (memoryMax !== null) {
    const limit = memoryMax.trim() === 'max' ? 0 : wholeBytes(memoryMax);
    if (limit !== null) {
      samples.push({ name: 'nyabase_container_mem_limit_bytes', labels, value: limit });
    }
  }
  const ioStat = await readOptional(fileSystem, `${directory}/io.stat`);
  if (ioStat !== null) {
    const io = sumIoBytes(ioStat);
    if (io) {
      samples.push(
        { name: 'nyabase_container_disk_io_read_bytes_total', labels, value: io.read },
        { name: 'nyabase_container_disk_io_write_bytes_total', labels, value: io.write },
      );
    }
  }
  return samples;
}

async function kernelCpuLimit(
  fileSystem: ReadOnlyNodeFileSystem,
  directory: string,
  cpuMax: string,
): Promise<number | null> {
  const parts = cpuMax.trim().split(/\s+/);
  if (parts[0] === 'max') {
    const cpuset = await readOptional(fileSystem, `${directory}/cpuset.cpus`);
    if (cpuset === null || cpuset.trim() === '') return 0;
    return countCpus(cpuset);
  }
  const quota = Number(parts[0]);
  const period = Number(parts[1]);
  if (!Number.isFinite(quota) || !Number.isFinite(period) || quota <= 0 || period <= 0) return null;
  return quota / period;
}

export function countCpus(text: string): number {
  let count = 0;
  for (const part of text.split(',')) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!match) continue;
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (end >= start) count += end - start + 1;
  }
  return count;
}

function usageSeconds(content: string): number | null {
  const match = /(?:^|\s)usage_usec\s+(\d+)/.exec(content);
  if (!match) return null;
  return Number(match[1]) / 1_000_000;
}

function wholeBytes(content: string): number | null {
  const value = Number(content.trim());
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

function sumIoBytes(content: string): { read: number; write: number } | null {
  let read = 0;
  let write = 0;
  let saw = false;
  for (const line of content.split(/\r?\n/)) {
    const rbytes = /(?:^|\s)rbytes=(\d+)/.exec(line);
    const wbytes = /(?:^|\s)wbytes=(\d+)/.exec(line);
    if (!rbytes && !wbytes) continue;
    saw = true;
    read += rbytes ? Number(rbytes[1]) : 0;
    write += wbytes ? Number(wbytes[1]) : 0;
  }
  return saw ? { read, write } : null;
}

async function readOptional(
  fileSystem: ReadOnlyNodeFileSystem,
  path: string,
): Promise<string | null> {
  try {
    return await fileSystem.readFile(path);
  } catch {
    return null;
  }
}
