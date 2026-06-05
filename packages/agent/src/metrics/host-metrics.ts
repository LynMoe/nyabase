import * as fs from 'fs';
import { MetricPoint, DiskInfo } from '@nyabase/common';

export class HostMetricsCollector {
  private lastCpuStats: { idle: number; total: number } | null = null;

  collectHostMetrics(serverId: string, disks: DiskInfo[]): MetricPoint[] {
    const ts = Date.now();
    const points: MetricPoint[] = [];
    const baseLabels = { server: serverId };

    // CPU
    const cpu = this.readCpuUsage();
    if (cpu !== null) {
      points.push({ name: 'nyabase_host_cpu_usage_ratio', labels: baseLabels, value: cpu, ts });
    }

    // Memory
    const mem = this.readMemInfo();
    if (mem) {
      points.push({ name: 'nyabase_host_mem_total_bytes', labels: baseLabels, value: mem.total, ts });
      points.push({ name: 'nyabase_host_mem_used_bytes', labels: baseLabels, value: mem.used, ts });
      points.push({ name: 'nyabase_host_mem_available_bytes', labels: baseLabels, value: mem.available, ts });
    }

    // Load average
    const load = this.readLoadAvg();
    if (load) {
      points.push({ name: 'nyabase_host_load1', labels: baseLabels, value: load[0], ts });
      points.push({ name: 'nyabase_host_load5', labels: baseLabels, value: load[1], ts });
      points.push({ name: 'nyabase_host_load15', labels: baseLabels, value: load[2], ts });
    }

    // Disk capacity
    for (const disk of disks) {
      const labels = { server: serverId, disk_id: disk.diskId, mount: disk.mountPoint };
      points.push({ name: 'nyabase_disk_total_bytes', labels, value: disk.totalBytes, ts });
      points.push({ name: 'nyabase_disk_used_bytes', labels, value: disk.usedBytes, ts });
    }

    // Disk IO (counters)
    const diskIo = this.readDiskStats(serverId, ts);
    points.push(...diskIo);

    // Network IO (counters)
    const netIo = this.readNetDev(serverId, ts);
    points.push(...netIo);

    return points;
  }

  private readCpuUsage(): number | null {
    try {
      const stat = fs.readFileSync('/proc/stat', 'utf-8');
      const line = stat.split('\n').find((l) => l.startsWith('cpu '));
      if (!line) return null;

      const parts = line.trim().split(/\s+/).slice(1).map(Number);
      const idle = parts[3] + (parts[4] ?? 0);
      const total = parts.reduce((a, b) => a + b, 0);

      if (!this.lastCpuStats) {
        this.lastCpuStats = { idle, total };
        return null;
      }

      const dIdle = idle - this.lastCpuStats.idle;
      const dTotal = total - this.lastCpuStats.total;
      this.lastCpuStats = { idle, total };

      return dTotal === 0 ? 0 : 1 - dIdle / dTotal;
    } catch {
      return null;
    }
  }

  private readMemInfo(): { total: number; used: number; available: number } | null {
    try {
      const content = fs.readFileSync('/proc/meminfo', 'utf-8');
      const get = (key: string) => {
        const m = content.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'));
        return m ? parseInt(m[1], 10) * 1024 : 0;
      };
      const total = get('MemTotal');
      const available = get('MemAvailable');
      return { total, used: total - available, available };
    } catch {
      return null;
    }
  }

  private readLoadAvg(): [number, number, number] | null {
    try {
      const content = fs.readFileSync('/proc/loadavg', 'utf-8');
      const parts = content.trim().split(/\s+/);
      return [parseFloat(parts[0]), parseFloat(parts[1]), parseFloat(parts[2])];
    } catch {
      return null;
    }
  }

  /** Read /proc/diskstats and emit counters for physical block devices */
  private readDiskStats(serverId: string, ts: number): MetricPoint[] {
    const points: MetricPoint[] = [];
    try {
      const content = fs.readFileSync('/proc/diskstats', 'utf-8');
      for (const line of content.split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 14) continue;
        const dev = parts[2];
        // Skip loop, ram, dm-, md, virtual partitions (ending in digit after a letter)
        if (
          dev.startsWith('loop') ||
          dev.startsWith('ram') ||
          dev.startsWith('dm-') ||
          dev.startsWith('md') ||
          /[a-z]\d+$/.test(dev)
        ) continue;

        // sectors × 512 = bytes
        const sectorsRead = parseInt(parts[5], 10);
        const sectorsWrite = parseInt(parts[9], 10);
        const readBytes = sectorsRead * 512;
        const writeBytes = sectorsWrite * 512;

        const labels = { server: serverId, dev };
        points.push({ name: 'nyabase_host_disk_read_bytes_total', labels, value: readBytes, ts });
        points.push({ name: 'nyabase_host_disk_write_bytes_total', labels, value: writeBytes, ts });
      }
    } catch { /* no /proc/diskstats on this platform */ }
    return points;
  }

  /** Read /proc/net/dev and emit counters for physical interfaces */
  private readNetDev(serverId: string, ts: number): MetricPoint[] {
    const points: MetricPoint[] = [];
    try {
      const content = fs.readFileSync('/proc/net/dev', 'utf-8');
      for (const line of content.split('\n').slice(2)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const colonIdx = trimmed.indexOf(':');
        if (colonIdx === -1) continue;
        const iface = trimmed.slice(0, colonIdx).trim();

        // Keep only physical/real interfaces; skip virtual/docker bridges
        if (
          iface === 'lo' ||
          iface.startsWith('docker') ||
          iface.startsWith('veth') ||
          iface.startsWith('br-') ||
          iface.startsWith('virbr') ||
          iface.startsWith('tun') ||
          iface.startsWith('dummy')
        ) continue;

        const vals = trimmed.slice(colonIdx + 1).trim().split(/\s+/).map(Number);
        // /proc/net/dev columns: rx_bytes rx_packets rx_errs rx_drop rx_fifo rx_frame rx_compressed rx_multicast
        //                         tx_bytes tx_packets ...
        const rxBytes = vals[0];
        const txBytes = vals[8];
        if (isNaN(rxBytes) || isNaN(txBytes)) continue;

        const labels = { server: serverId, iface };
        points.push({ name: 'nyabase_host_net_rx_bytes_total', labels, value: rxBytes, ts });
        points.push({ name: 'nyabase_host_net_tx_bytes_total', labels, value: txBytes, ts });
      }
    } catch { /* no /proc/net/dev on this platform */ }
    return points;
  }

  collectContainerMetrics(
    serverId: string,
    containerId: string,
    containerName: string,
    ownerId: string,
    cgroupPath: string,
  ): MetricPoint[] {
    const ts = Date.now();
    const labels = {
      server: serverId,
      container_id: containerId.slice(0, 12),
      container_name: containerName,
      user_id: ownerId,
    };
    const points: MetricPoint[] = [];

    // CPU (cgroup v2)
    try {
      const cpuStat = fs.readFileSync(`${cgroupPath}/cpu.stat`, 'utf-8');
      const usageMatch = cpuStat.match(/^usage_usec (\d+)/m);
      if (usageMatch) {
        points.push({
          name: 'nyabase_container_cpu_usage_usec',
          labels,
          value: parseInt(usageMatch[1], 10),
          ts,
        });
      }
    } catch { /* not available */ }

    // Memory (cgroup v2)
    try {
      const memCurrent = fs.readFileSync(`${cgroupPath}/memory.current`, 'utf-8');
      const memMax = fs.readFileSync(`${cgroupPath}/memory.max`, 'utf-8');
      points.push({
        name: 'nyabase_container_mem_used_bytes',
        labels,
        value: parseInt(memCurrent.trim(), 10),
        ts,
      });
      const maxStr = memMax.trim();
      if (maxStr !== 'max') {
        points.push({
          name: 'nyabase_container_mem_limit_bytes',
          labels,
          value: parseInt(maxStr, 10),
          ts,
        });
      }
    } catch { /* not available */ }

    // Disk IO (cgroup v2 io.stat)
    try {
      const ioStat = fs.readFileSync(`${cgroupPath}/io.stat`, 'utf-8');
      let totalRead = 0;
      let totalWrite = 0;
      for (const line of ioStat.split('\n')) {
        const rbMatch = line.match(/rbytes=(\d+)/);
        const wbMatch = line.match(/wbytes=(\d+)/);
        if (rbMatch) totalRead += parseInt(rbMatch[1], 10);
        if (wbMatch) totalWrite += parseInt(wbMatch[1], 10);
      }
      if (totalRead > 0 || totalWrite > 0) {
        points.push({ name: 'nyabase_container_io_read_bytes_total', labels, value: totalRead, ts });
        points.push({ name: 'nyabase_container_io_write_bytes_total', labels, value: totalWrite, ts });
      }
    } catch { /* not available */ }

    return points;
  }
}
