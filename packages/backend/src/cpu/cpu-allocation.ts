import type { ServerCpuTopologyEntry } from '../platform/persistence-pg/infrastructure-database.types.js';

export { formatCpuSet } from '../incus/index.js';

/*
 * Pure CPU-set arithmetic. A user granted N cores on a server gets N logical
 * CPUs out of the unreserved ones; every container the user runs there is
 * pinned to exactly that set, so together they can never use more than N.
 */

/** Logical CPUs reported online by Incus resources, with their physical placement. */
export function parseCpuTopology(resources: unknown): ServerCpuTopologyEntry[] {
  const sockets = (resources as { cpu?: { sockets?: unknown } } | undefined)?.cpu?.sockets;
  if (!Array.isArray(sockets)) return [];
  const entries: ServerCpuTopologyEntry[] = [];
  for (const socket of sockets as Array<{ socket?: number; cores?: unknown }>) {
    if (!Array.isArray(socket.cores)) continue;
    for (const core of socket.cores as Array<{ core?: number; threads?: unknown }>) {
      if (!Array.isArray(core.threads)) continue;
      for (const thread of core.threads as Array<{ id?: number; numa_node?: number; online?: boolean }>) {
        if (!Number.isSafeInteger(thread.id) || thread.online === false) continue;
        entries.push({
          id: thread.id!,
          core: Number.isSafeInteger(core.core) ? core.core! : thread.id!,
          socket: Number.isSafeInteger(socket.socket) ? socket.socket! : 0,
          numa: Number.isSafeInteger(thread.numa_node) ? thread.numa_node! : 0,
        });
      }
    }
  }
  return entries.sort((left, right) => left.id - right.id);
}

export function allocatableCpus(
  topology: readonly ServerCpuTopologyEntry[],
  reserved: readonly number[],
): number[] {
  const excluded = new Set(reserved);
  return topology.map((entry) => entry.id).filter((id) => !excluded.has(id)).sort((a, b) => a - b);
}

export interface CpuAllocationInput {
  readonly topology: readonly ServerCpuTopologyEntry[];
  readonly reserved: readonly number[];
  /** Whole logical CPUs granted. */
  readonly cores: number;
  /** The user's current set; kept as far as it still fits. */
  readonly current: readonly number[];
  /** Sets of the other users with live containers on the server. */
  readonly others: readonly (readonly number[])[];
}

/**
 * Choose `cores` CPUs: keep what the user already has, then prefer the least
 * shared CPUs, then completing physical cores, then the NUMA node most of the
 * set already sits on. Sets only overlap when the free CPUs run out.
 */
export function allocateCpuSet(input: CpuAllocationInput): number[] {
  const allocatable = allocatableCpus(input.topology, input.reserved);
  if (input.cores >= allocatable.length) return allocatable;
  const byId = new Map(input.topology.map((entry) => [entry.id, entry]));
  const coreOf = new Map(allocatable.map((cpu) => {
    const entry = byId.get(cpu)!;
    return [cpu, `${entry.socket}:${entry.core}`] as const;
  }));
  const load = new Map<number, number>();
  for (const set of input.others) {
    for (const cpu of set) load.set(cpu, (load.get(cpu) ?? 0) + 1);
  }
  const loadOf = (cpu: number): number => load.get(cpu) ?? 0;
  // Shared load of each physical core, computed once.
  const coreLoad = new Map<string, number>();
  for (const cpu of allocatable) {
    const key = coreOf.get(cpu)!;
    coreLoad.set(key, (coreLoad.get(key) ?? 0) + loadOf(cpu));
  }
  const allowed = new Set(allocatable);
  const chosen = new Set(input.current.filter((cpu) => allowed.has(cpu)));
  // CPUs of the set per physical core and NUMA node, kept current as the set changes.
  const chosenPerCore = new Map<string, number>();
  const chosenPerNuma = new Map<number, number>();
  const count = (cpu: number, delta: number): void => {
    const key = coreOf.get(cpu)!;
    const numa = byId.get(cpu)!.numa;
    chosenPerCore.set(key, (chosenPerCore.get(key) ?? 0) + delta);
    chosenPerNuma.set(numa, (chosenPerNuma.get(numa) ?? 0) + delta);
  };
  for (const cpu of chosen) count(cpu, 1);
  const siblingsChosen = (cpu: number): number =>
    (chosenPerCore.get(coreOf.get(cpu)!) ?? 0) - (chosen.has(cpu) ? 1 : 0);
  const numaChosen = (cpu: number): number => chosenPerNuma.get(byId.get(cpu)!.numa) ?? 0;

  // Drop the most shared CPU first, then one whose core is incomplete anyway, then the highest id.
  const dropBefore = (left: number, right: number): boolean =>
    compare(loadOf(left), loadOf(right), true)
    ?? compare(siblingsChosen(left), siblingsChosen(right), false)
    ?? left > right;
  // Avoid other users' CPUs first, then complete a physical core, then the least shared core,
  // then the set's NUMA node, then the lowest id.
  const addBefore = (left: number, right: number): boolean =>
    compare(loadOf(left), loadOf(right), false)
    ?? compare(siblingsChosen(left), siblingsChosen(right), true)
    ?? compare(coreLoad.get(coreOf.get(left)!)!, coreLoad.get(coreOf.get(right)!)!, false)
    ?? compare(numaChosen(left), numaChosen(right), true)
    ?? left < right;

  while (chosen.size > input.cores) {
    let victim = -1;
    for (const cpu of chosen) {
      if (victim < 0 || dropBefore(cpu, victim)) victim = cpu;
    }
    chosen.delete(victim);
    count(victim, -1);
  }
  while (chosen.size < input.cores) {
    let best = -1;
    for (const cpu of allocatable) {
      if (chosen.has(cpu)) continue;
      if (best < 0 || addBefore(cpu, best)) best = cpu;
    }
    chosen.add(best);
    count(best, 1);
  }
  return [...chosen].sort((left, right) => left - right);
}

/** Whether `left` goes first (higher first when `descending`); undefined on a tie. */
function compare(left: number, right: number, descending: boolean): boolean | undefined {
  if (left === right) return undefined;
  return descending ? left > right : left < right;
}

/** Is `set` still a valid pinning of `cores` CPUs under the current topology and reservations? */
export function cpuSetStillFits(
  set: readonly number[],
  cores: number,
  topology: readonly ServerCpuTopologyEntry[],
  reserved: readonly number[],
): boolean {
  const allocatable = allocatableCpus(topology, reserved);
  const allowed = new Set(allocatable);
  const expectedSize = Math.min(cores, allocatable.length);
  return set.length === expectedSize && new Set(set).size === set.length && set.every((cpu) => allowed.has(cpu));
}
