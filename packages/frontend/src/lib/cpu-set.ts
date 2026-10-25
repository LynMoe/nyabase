import { MAX_SERVER_LOGICAL_CPU_ID, type ServerCpuDto } from '@nyabase/common';

/** Logical CPU ids as compact ranges: [0, 1, 2, 3, 8] → "0-3,8". */
export function formatCpuList(cpus: readonly number[]): string {
  const sorted = [...new Set(cpus)].sort((a, b) => a - b);
  const parts: string[] = [];
  let start: number | null = null;
  let previous: number | null = null;
  for (const cpu of sorted) {
    if (start !== null && previous !== null && cpu === previous + 1) {
      previous = cpu;
      continue;
    }
    if (start !== null && previous !== null) parts.push(start === previous ? `${start}` : `${start}-${previous}`);
    start = cpu;
    previous = cpu;
  }
  if (start !== null && previous !== null) parts.push(start === previous ? `${start}` : `${start}-${previous}`);
  return parts.join(',');
}

export type CpuListParse = { ok: true; cpus: number[] } | { ok: false; error: string };

/** Parses "0,1" / "0-3,8" (spaces and Chinese commas allowed); empty text is an empty list. */
export function parseCpuList(text: string): CpuListParse {
  const cpus = new Set<number>();
  const tokens = text.split(/[,，\s]+/).map((token) => token.trim()).filter((token) => token.length > 0);
  for (const token of tokens) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(token);
    if (!match) return { ok: false, error: `无法识别「${token}」，请使用 0,1 或 0-3 这样的格式` };
    const from = Number(match[1]);
    const to = match[2] === undefined ? from : Number(match[2]);
    if (to < from) return { ok: false, error: `范围「${token}」的结束编号小于起始编号` };
    if (to > MAX_SERVER_LOGICAL_CPU_ID) return { ok: false, error: `CPU 编号不能超过 ${MAX_SERVER_LOGICAL_CPU_ID}` };
    for (let cpu = from; cpu <= to; cpu += 1) cpus.add(cpu);
  }
  return { ok: true, cpus: [...cpus].sort((a, b) => a - b) };
}

/** A grant's cores on user surfaces; null means every core the server offers. */
export function cpuGrantLabel(cores: number | null): string {
  return cores === null ? '全部' : `${cores} 核`;
}

/** Whole cores of a grant; null means every unreserved CPU. */
export function cpuCoresLabel(cores: number | null): string {
  return cores === null ? '不限' : `${cores} 核`;
}

export type CpuTopologyGroup = {
  key: string;
  socket: number;
  numa: number;
  cores: Array<{ core: number; cpus: number[] }>;
};

/** Logical CPUs grouped by socket / NUMA node, then by physical core (hyperthread siblings together). */
export function groupCpuTopology(topology: readonly ServerCpuDto[]): CpuTopologyGroup[] {
  const groups = new Map<string, CpuTopologyGroup>();
  for (const cpu of [...topology].sort((a, b) => a.id - b.id)) {
    const key = `${cpu.socket}:${cpu.numa}`;
    const group = groups.get(key) ?? { key, socket: cpu.socket, numa: cpu.numa, cores: [] };
    groups.set(key, group);
    const core = group.cores.find((item) => item.core === cpu.core);
    if (core) core.cpus.push(cpu.id);
    else group.cores.push({ core: cpu.core, cpus: [cpu.id] });
  }
  return [...groups.values()].sort((a, b) => a.socket - b.socket || a.numa - b.numa);
}
