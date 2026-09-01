import { execFile as childExecFile } from 'node:child_process';
import { readFile as fsReadFile, readdir as fsReaddir } from 'node:fs/promises';
import { isIP } from 'node:net';
import { promisify } from 'node:util';
import { canonicalPciAddress, type NodeMetricSample } from '@nyabase/common';

const execFile = promisify(childExecFile);
const COMMAND_TIMEOUT_MS = 1_000;
const NFT_TIMEOUT_MS = 400;
const IP_ADDR_TIMEOUT_MS = 250;
const COMMAND_MAX_BUFFER_BYTES = 256 * 1024;
const BYTES_PER_DISK_SECTOR = 512;
const BYTES_PER_MIB = 1024 * 1024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ReadOnlyNodeFileSystem {
  readFile(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
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

export interface LinuxNodeMetricsCollectorOptions {
  readonly parentInterface?: string;
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
  readdir: async (path) => {
    const entries = await fsReaddir(path, { withFileTypes: true });
    return entries
      .filter((entry) => !entry.name.startsWith('.'))
      .map((entry) => entry.name);
  },
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
    // smartctl can return a non-zero status while still providing valid JSON.
    // Preserve its read-only stdout for the caller without exposing it in logs.
    const commandError = error as { stdout?: unknown; stderr?: unknown };
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      stdout: typeof commandError.stdout === 'string' ? commandError.stdout : '',
      stderr: typeof commandError.stderr === 'string' ? commandError.stderr : '',
    });
  }
};

export class LinuxNodeMetricsCollector {
  private readonly fileSystem: ReadOnlyNodeFileSystem;
  private readonly command: ReadOnlyCommand;
  private readonly previousCpu = new Map<string, { idle: number; total: number }>();

  constructor(private readonly options: LinuxNodeMetricsCollectorOptions = {}) {
    this.fileSystem = options.fileSystem ?? defaultFileSystem;
    this.command = options.command ?? defaultCommand;
  }

  async collect(): Promise<NodeMetricSample[]> {
    const groups = await Promise.all([
      this.collectCpu(),
      this.collectPsi(),
      this.collectDiskMetrics(),
      this.collectGpuMetrics(),
      this.collectNetworkEvidence(),
    ]);
    return groups.flat();
  }

  private async collectCpu(): Promise<NodeMetricSample[]> {
    let content: string;
    try {
      content = await this.fileSystem.readFile('/proc/stat');
    } catch {
      return [];
    }
    const samples: NodeMetricSample[] = [];
    for (const line of content.split(/\r?\n/)) {
      const match = /^cpu([0-9]+)\s+(.+)$/.exec(line.trim());
      if (!match) continue;
      const values = match[2].split(/\s+/).map(Number);
      if (values.length < 4 || values.some((value) => !Number.isFinite(value))) continue;
      const total = values.reduce((sum, value) => sum + value, 0);
      const idle = values[3] + (values[4] ?? 0);
      const key = match[1];
      const previous = this.previousCpu.get(key);
      this.previousCpu.set(key, { idle, total });
      if (!previous) continue;
      const totalDelta = total - previous.total;
      const idleDelta = idle - previous.idle;
      if (totalDelta <= 0 || idleDelta < 0) continue;
      samples.push({
        name: 'nyabase_node_cpu_usage_ratio',
        labels: { cpu: key },
        value: clampRatio(1 - idleDelta / totalDelta),
      });
    }
    return samples;
  }

  private async collectPsi(): Promise<NodeMetricSample[]> {
    let content: string;
    try {
      content = await this.fileSystem.readFile('/proc/pressure/cpu');
    } catch {
      return [];
    }
    const samples: NodeMetricSample[] = [];
    for (const line of content.split(/\r?\n/)) {
      const match = /^(some|full)\s+(.+)$/.exec(line.trim());
      if (!match) continue;
      const values = new Map<string, number>();
      for (const part of match[2].split(/\s+/)) {
        const value = /^avg(10|60|300)=([0-9]+(?:\.[0-9]+)?)$/.exec(part);
        if (value) values.set(value[1], Number(value[2]) / 100);
      }
      for (const window of ['10', '60', '300'] as const) {
        const ratio = values.get(window);
        if (ratio === undefined || !Number.isFinite(ratio)) continue;
        samples.push({
          name: 'nyabase_node_cpu_psi_ratio',
          labels: { scope: match[1], window },
          value: clampRatio(ratio),
        });
      }
    }
    return samples;
  }

  private async collectDiskMetrics(): Promise<NodeMetricSample[]> {
    let content: string;
    try {
      content = await this.fileSystem.readFile('/proc/diskstats');
    } catch {
      return [];
    }
    const devices = parseDiskStats(content);
    const groups = await Promise.all(devices.map(async (device) => {
      const deviceId = await this.stableDeviceId(device.name);
      if (!deviceId) return [];
      const samples: NodeMetricSample[] = [
        {
          name: 'nyabase_node_disk_io_read_bytes_total',
          labels: { device_id: deviceId },
          value: device.readSectors * BYTES_PER_DISK_SECTOR,
        },
        {
          name: 'nyabase_node_disk_io_write_bytes_total',
          labels: { device_id: deviceId },
          value: device.writeSectors * BYTES_PER_DISK_SECTOR,
        },
        {
          name: 'nyabase_node_disk_io_read_seconds_total',
          labels: { device_id: deviceId },
          value: device.readTicks / 100,
        },
        {
          name: 'nyabase_node_disk_io_write_seconds_total',
          labels: { device_id: deviceId },
          value: device.writeTicks / 100,
        },
      ];
      const smart = await this.readSmartHealth(device.name);
      if (smart !== undefined) {
        samples.push({
          name: 'nyabase_node_disk_smart_health',
          labels: { device_id: deviceId },
          value: smart ? 1 : 0,
        });
      }
      return samples;
    }));
    return groups.flat();
  }

  private async stableDeviceId(device: string): Promise<string | undefined> {
    for (const field of ['wwid', 'serial']) {
      try {
        const raw = (await this.fileSystem.readFile(
          `/sys/class/block/${device}/device/${field}`,
        )).trim();
        const normalized = raw.replace(/\s+/g, '-').replace(/[^A-Za-z0-9_.:-]/g, '_');
        if (normalized.length > 0 && normalized.length <= 256) return normalized;
      } catch {
        // Try the next stable identity source.
      }
    }
    return undefined;
  }

  private async readSmartHealth(device: string): Promise<boolean | undefined> {
    let stdout = '';
    try {
      ({ stdout } = await this.command(
        'smartctl',
        ['-H', '-j', `/dev/${device}`],
        { timeout: COMMAND_TIMEOUT_MS, maxBuffer: COMMAND_MAX_BUFFER_BYTES },
      ));
    } catch (error) {
      stdout = typeof (error as { stdout?: unknown }).stdout === 'string'
        ? (error as { stdout: string }).stdout
        : '';
    }
    if (!stdout) return undefined;
    try {
      const parsed = JSON.parse(stdout) as {
        smart_status?: { passed?: unknown };
      };
      return typeof parsed.smart_status?.passed === 'boolean'
        ? parsed.smart_status.passed
        : undefined;
    } catch {
      return undefined;
    }
  }

  private async collectGpuMetrics(): Promise<NodeMetricSample[]> {
    let gpuStdout: string;
    try {
      ({ stdout: gpuStdout } = await this.command(
        'nvidia-smi',
        [
          '--query-gpu=index,pci.bus_id,uuid,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw',
          '--format=csv,noheader,nounits',
        ],
        { timeout: COMMAND_TIMEOUT_MS, maxBuffer: COMMAND_MAX_BUFFER_BYTES },
      ));
    } catch {
      return [];
    }
    const gpus = parseGpuStats(gpuStdout);
    if (gpus.length === 0) return [];
    const samples: NodeMetricSample[] = [];
    for (const gpu of gpus) {
      const labels = { gpu_pci: gpu.pci };
      addSample(samples, 'nyabase_node_gpu_smi_index', labels, gpu.index);
      addSample(samples, 'nyabase_node_gpu_util_ratio', labels, gpu.utilizationRatio);
      addSample(samples, 'nyabase_node_gpu_mem_used_bytes', labels, gpu.memoryUsedBytes);
      addSample(samples, 'nyabase_node_gpu_mem_total_bytes', labels, gpu.memoryTotalBytes);
      addSample(samples, 'nyabase_node_gpu_temperature_celsius', labels, gpu.temperatureCelsius);
      addSample(samples, 'nyabase_node_gpu_power_watts', labels, gpu.powerWatts);
    }
    samples.push(...await this.collectGpuProcessMetrics(gpus));
    return samples;
  }

  private async collectGpuProcessMetrics(gpus: readonly GpuMetricRecord[]): Promise<NodeMetricSample[]> {
    let stdout: string;
    try {
      ({ stdout } = await this.command(
        'nvidia-smi',
        [
          '--query-compute-apps=pid,used_memory,gpu_uuid',
          '--format=csv,noheader,nounits',
        ],
        { timeout: COMMAND_TIMEOUT_MS, maxBuffer: COMMAND_MAX_BUFFER_BYTES },
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
      const containerId = await this.pidContainerId(pid);
      processes.push({
        gpuUuid,
        memoryUsedBytes: memoryMiB * BYTES_PER_MIB,
        containerId,
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

  private async pidContainerId(pid: number): Promise<string> {
    try {
      const content = await this.fileSystem.readFile(`/proc/${pid}/cgroup`);
      const match = content.match(
        /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i,
      );
      if (match && UUID_PATTERN.test(match[0])) return match[0].toLowerCase();
    } catch {
      // A process can disappear between nvidia-smi and the cgroup read.
    }
    return '__unattributed__';
  }

  private async collectNetworkEvidence(): Promise<NodeMetricSample[]> {
    const confInterfaces = await this.listInterfaceNames('/proc/sys/net/ipv4/conf');
    const sysfsInterfaces = await this.listInterfaceNames('/sys/class/net');
    const names = new Set<string>([...confInterfaces, ...sysfsInterfaces]);
    if (names.size === 0 && this.options.parentInterface && isSafeInterface(this.options.parentInterface)) {
      names.add(this.options.parentInterface);
    }
    const samples: NodeMetricSample[] = [];
    const bridges: string[] = [];
    for (const name of [...names].sort()) {
      if (!isSysctlAggregate(name)) {
        const isBridge = await this.directoryExists(`/sys/class/net/${name}/bridge`);
        samples.push({
          name: 'nyabase_node_network_is_bridge',
          labels: { interface: name },
          value: isBridge ? 1 : 0,
        });
        if (isBridge) bridges.push(name);
      }
    }
    for (const bridge of bridges) {
      const slaves = await this.listInterfaceNames(`/sys/class/net/${bridge}/brif`);
      for (const slave of slaves.sort()) {
        names.add(slave);
        samples.push({
          name: 'nyabase_node_network_bridge_slave',
          labels: { bridge, interface: slave },
          value: 1,
        });
      }
    }
    const interfaces = [...names].filter(isSafeInterface).sort();
    for (const name of interfaces) {
      const forwarding = await this.readSysctl(name, 'forwarding');
      if (forwarding !== undefined) {
        samples.push({
          name: 'nyabase_node_network_forwarding',
          labels: { interface: name },
          value: forwarding,
        });
      }
      const rpFilter = await this.readSysctl(name, 'rp_filter');
      if (rpFilter !== undefined) {
        samples.push({
          name: 'nyabase_node_network_rp_filter',
          labels: { interface: name },
          value: rpFilter,
        });
      }
    }
    const ipv4Present = await this.collectIpv4Present();
    if (ipv4Present) {
      for (const name of interfaces) {
        if (isSysctlAggregate(name)) continue;
        samples.push({
          name: 'nyabase_node_network_ipv4_present',
          labels: { interface: name },
          value: ipv4Present.has(name) ? 1 : 0,
        });
      }
    }
    await this.collectFibRule(samples, interfaces);
    await this.collectNftBridgeFilters(samples);
    return samples;
  }

  private async listInterfaceNames(path: string): Promise<string[]> {
    try {
      return (await this.fileSystem.readdir(path)).filter(isSafeInterface);
    } catch {
      return [];
    }
  }

  private async directoryExists(path: string): Promise<boolean> {
    try {
      await this.fileSystem.readdir(path);
      return true;
    } catch {
      return false;
    }
  }

  private async collectIpv4Present(): Promise<Set<string> | undefined> {
    try {
      const { stdout } = await this.command(
        'ip',
        ['-4', '-o', 'addr', 'show'],
        { timeout: IP_ADDR_TIMEOUT_MS, maxBuffer: COMMAND_MAX_BUFFER_BYTES },
      );
      return parseGlobalIpv4Interfaces(stdout);
    } catch {
      return undefined;
    }
  }

  private async collectFibRule(
    samples: NodeMetricSample[],
    interfaces: readonly string[],
  ): Promise<void> {
    // Leftover routed-NIC diagnostic. Bridged anti-spoof is nft bridge-family,
    // not FIB; keep emitting 0 so the allowlist does not drop accidentally.
    for (const name of interfaces) {
      samples.push({
        name: 'nyabase_node_network_fib_rule_present',
        labels: { interface: name },
        value: 0,
      });
    }
  }

  private async collectNftBridgeFilters(samples: NodeMetricSample[]): Promise<void> {
    try {
      const { stdout } = await this.command(
        'nft',
        ['list', 'table', 'bridge', 'incus'],
        { timeout: NFT_TIMEOUT_MS, maxBuffer: COMMAND_MAX_BUFFER_BYTES },
      );
      samples.push({
        name: 'nyabase_node_network_nft_available',
        labels: {},
        value: 1,
      });
      const parsed = parseNftBridgeFilters(stdout);
      samples.push({
        name: 'nyabase_node_network_bridge_filter_present',
        labels: {},
        value: parsed.present ? 1 : 0,
      });
      for (const address of parsed.addresses) {
        samples.push({
          name: 'nyabase_node_network_bridge_filter_address',
          labels: { address },
          value: 1,
        });
      }
    } catch (error) {
      const details = commandErrorDetails(error);
      if (isMissingNftTable(details.stderr)) {
        samples.push({
          name: 'nyabase_node_network_nft_available',
          labels: {},
          value: 1,
        });
        samples.push({
          name: 'nyabase_node_network_bridge_filter_present',
          labels: {},
          value: 0,
        });
        return;
      }
      samples.push({
        name: 'nyabase_node_network_nft_available',
        labels: {},
        value: 0,
      });
    }
  }

  private async readSysctl(interfaceName: string, field: string): Promise<number | undefined> {
    try {
      const value = Number(await this.fileSystem.readFile(
        `/proc/sys/net/ipv4/conf/${interfaceName}/${field}`,
      ));
      return Number.isInteger(value) && value >= 0 ? value : undefined;
    } catch {
      return undefined;
    }
  }
}

export function parseDiskStats(content: string): Array<{
  readonly name: string;
  readonly readSectors: number;
  readonly writeSectors: number;
  readonly readTicks: number;
  readonly writeTicks: number;
}> {
  const devices: Array<{
    name: string;
    readSectors: number;
    writeSectors: number;
    readTicks: number;
    writeTicks: number;
  }> = [];
  for (const line of content.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 14) continue;
    const name = fields[2];
    if (!name || isVirtualBlockDevice(name) || !/^[A-Za-z0-9_.:-]+$/.test(name)) continue;
    const values = [fields[5], fields[6], fields[9], fields[10]].map(Number);
    if (values.some((value) => !Number.isFinite(value) || value < 0)) continue;
    devices.push({
      name,
      readSectors: values[0],
      readTicks: values[1],
      writeSectors: values[2],
      writeTicks: values[3],
    });
  }
  return devices;
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

function clampRatio(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function isVirtualBlockDevice(name: string): boolean {
  return (
    name.startsWith('loop')
    || name.startsWith('ram')
    || name.startsWith('dm-')
    || name.startsWith('md')
    || /^(?:sd[a-z]+\d+|vd[a-z]+\d+|xvd[a-z]+\d+|nvme\d+n\d+p\d+|mmcblk\d+p\d+)$/.test(name)
  );
}

function isSafeInterface(value: string): boolean {
  return /^[A-Za-z0-9_.:-]{1,64}$/.test(value);
}

function isSysctlAggregate(value: string): boolean {
  return value === 'all' || value === 'default';
}

function isExcludedIpv4(address: string): boolean {
  if (isIP(address) !== 4) return true;
  const parts = address.split('.').map(Number);
  if (parts[0] === 127) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  return false;
}

export function parseGlobalIpv4Interfaces(stdout: string): Set<string> {
  const present = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\d+:\s+([^\s@]+)(?:@\S+)?\s+inet\s+(\d+\.\d+\.\d+\.\d+)\/\d+.*\bscope\s+global\b/
      .exec(line.trim());
    if (!match) continue;
    const iface = match[1];
    const address = match[2];
    if (!isSafeInterface(iface) || isExcludedIpv4(address)) continue;
    present.add(iface);
  }
  return present;
}

export function parseNftBridgeFilters(stdout: string): {
  readonly addresses: readonly string[];
  readonly present: boolean;
} {
  const addresses = new Set<string>();
  let arpDrop = false;
  let ipDrop = false;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    const isArp = /\barp\s+saddr\s+ip\b/i.test(trimmed);
    const isIp = !isArp && /\bip\s+saddr\b/i.test(trimmed);
    if ((!isArp && !isIp) || !/\bdrop\b/i.test(trimmed)) continue;
    if (isArp) arpDrop = true;
    if (isIp) ipDrop = true;
    const setMatch = /\{([^}]+)\}/.exec(trimmed);
    const tokens = setMatch
      ? setMatch[1].split(/[\s,]+/)
      : [...trimmed.matchAll(/\b(\d{1,3}(?:\.\d{1,3}){3})(?:\/32)?\b/g)].map((match) => match[1]);
    for (const token of tokens) {
      const bare = token.replace(/\/32$/, '');
      if (isIP(bare) === 4 && !isExcludedIpv4(bare) && bare !== '0.0.0.0' && bare !== '255.255.255.255') {
        addresses.add(bare);
      }
    }
  }
  return { addresses: [...addresses].sort(), present: arpDrop && ipDrop };
}

function isMissingNftTable(stderr: string): boolean {
  return /no such (file or directory|table)/i.test(stderr);
}

function commandErrorDetails(error: unknown): {
  readonly code?: string | number;
  readonly killed?: boolean;
  readonly stderr: string;
} {
  if (typeof error !== 'object' || error === null) {
    return { stderr: String(error) };
  }
  const record = error as {
    code?: string | number;
    killed?: boolean;
    stderr?: unknown;
  };
  return {
    code: record.code,
    killed: record.killed,
    stderr: typeof record.stderr === 'string' ? record.stderr : '',
  };
}
