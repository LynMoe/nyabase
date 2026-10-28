import type { GrantServerProfileDto } from '@nyabase/common';
import { formatCompactBytes } from './grant-quota.js';

export interface ProfileRow {
  label: string;
  value: string;
  detail?: string;
}

function countByModel(models: Array<{ name: string; count: number }>): string {
  return models.map((model) => (model.count > 1 ? `${model.count} × ${model.name}` : model.name)).join('，');
}

function poolUsage(pool: GrantServerProfileDto['pools'][number]): string {
  if (pool.totalBytes === null) return '容量未知';
  const used = pool.usedBytes === null ? '用量未知' : `已用 ${formatCompactBytes(pool.usedBytes)}`;
  return `${used} / 共 ${formatCompactBytes(pool.totalBytes)}`;
}

/** The rows of the bundle form's server panel: CPU, memory, pools and GPUs. */
export function serverProfileRows(profile: GrantServerProfileDto): ProfileRow[] {
  const rows: ProfileRow[] = [];
  const { cpu } = profile;
  rows.push({
    label: 'CPU',
    value: cpu.logical === null
      ? '拓扑未上报'
      : `${cpu.logical} 线程 · 可分配 ${cpu.allocatable ?? cpu.logical}${cpu.reserved > 0 ? ` · 保留 ${cpu.reserved}` : ''}`,
    ...(cpu.models.length > 0
      ? { detail: countByModel(cpu.models.map((model) => ({ name: model.name, count: model.sockets }))) }
      : {}),
  });
  rows.push({
    label: '内存',
    value: profile.memoryBytes === null ? '未知' : formatCompactBytes(profile.memoryBytes),
  });
  const system = profile.pools.filter((pool) => pool.system);
  const data = profile.pools.filter((pool) => !pool.system);
  for (const pool of system) {
    rows.push({ label: '系统盘池', value: poolUsage(pool), detail: `${pool.name}（${pool.driver}）` });
  }
  if (system.length === 0) rows.push({ label: '系统盘池', value: '未设置' });
  for (const pool of data) {
    rows.push({ label: '数据盘池', value: poolUsage(pool), detail: `${pool.name}（${pool.driver}）` });
  }
  const cards = profile.gpu.cards;
  const models = new Map<string, number>();
  for (const card of cards) {
    if (card.model) models.set(card.model, (models.get(card.model) ?? 0) + 1);
  }
  rows.push({
    label: 'GPU',
    value: !profile.gpu.enabled
      ? (cards.length > 0 ? `${cards.length} 张（未启用 GPU）` : '未启用')
      : (cards.length > 0 ? `${cards.length} 张` : '无'),
    ...(models.size > 0
      ? { detail: countByModel([...models].map(([name, count]) => ({ name, count }))) }
      : {}),
  });
  return rows;
}
