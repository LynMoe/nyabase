import type { PerformanceHostSnapshot } from '@nyabase/common';
import { formatBytesCompact, formatPercent, formatRate } from '../../lib/utils.js';

export function hostOccupancy(host: PerformanceHostSnapshot): {
  cpu: string;
  cpuTitle?: string;
  memory: string;
  memoryTitle?: string;
  disk: string;
  diskTitle?: string;
  network: string;
  gpu: string | null;
  gpuTitle?: string;
} {
  const cores = host.cpuRatio !== null && host.cpuCount !== null && host.cpuCount > 0
    ? host.cpuRatio * host.cpuCount
    : null;
  const cpu = cores === null ? '—' : formatCores(cores);
  const cpuTitle = host.cpuRatio === null ? undefined : `占整机 ${formatPercent(host.cpuRatio)}`;
  const memory = host.memory.usedBytes === null ? '—' : formatBytesCompact(host.memory.usedBytes);
  const memoryTitle = host.memory.ratio === null ? undefined : `占整机 ${formatPercent(host.memory.ratio)}`;
  const disks = host.disks.filter((disk) => disk.usedBytes !== null && disk.sizeBytes !== null && disk.sizeBytes > 0);
  const diskUsed = disks.reduce((sum, disk) => sum + (disk.usedBytes ?? 0), 0);
  const diskSize = disks.reduce((sum, disk) => sum + (disk.sizeBytes ?? 0), 0);
  const disk = disks.length === 0 ? '—' : formatBytesCompact(diskUsed);
  const diskTitle = diskSize > 0 ? `占整机 ${formatPercent(diskUsed / diskSize)}` : undefined;
  const network = `↓ ${host.network.rxBytesPerSec === null ? '—' : formatRate(host.network.rxBytesPerSec)} ↑ ${host.network.txBytesPerSec === null ? '—' : formatRate(host.network.txBytesPerSec)}`;
  const gpuUsed = host.gpus.reduce((sum, card) => sum + (card.usedBytes ?? 0), 0);
  const gpuKnown = host.gpus.some((card) => card.usedBytes !== null);
  const gpuTotal = host.gpus.every((card) => card.totalBytes !== null)
    ? host.gpus.reduce((sum, card) => sum + (card.totalBytes ?? 0), 0)
    : null;
  const gpu = host.gpus.length === 0 || !gpuKnown ? null : formatBytesCompact(gpuUsed);
  const gpuTitle = gpu !== null && gpuTotal !== null && gpuTotal > 0 ? `占整机 ${formatPercent(gpuUsed / gpuTotal)}` : undefined;
  return { cpu, cpuTitle, memory, memoryTitle, disk, diskTitle, network, gpu, gpuTitle };
}

export function hostOccupancyLine(host: PerformanceHostSnapshot): string {
  const parts = hostOccupancy(host);
  return [`CPU ${parts.cpu}`, `内存 ${parts.memory}`, `磁盘 ${parts.disk}`, parts.network, parts.gpu ? `显存 ${parts.gpu}` : '']
    .filter(Boolean)
    .join(' · ');
}

export function hostOccupancyTitle(host: PerformanceHostSnapshot): string {
  const parts = hostOccupancy(host);
  return [parts.cpuTitle && `CPU ${parts.cpuTitle}`, parts.memoryTitle && `内存 ${parts.memoryTitle}`, parts.diskTitle && `磁盘 ${parts.diskTitle}`, parts.gpuTitle && `显存 ${parts.gpuTitle}`]
    .filter(Boolean)
    .join(' · ');
}

function formatCores(value: number): string {
  const text = Math.abs(value) >= 10 ? String(Math.round(value)) : value.toFixed(1);
  return `${text} 核`;
}
