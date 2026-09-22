import { canonicalPciAddress } from './pci.js';
import type { NvidiaGpuDeviceDto, NvidiaGpuGrant } from './schema.js';

export function permittedGpus(
  inventory: readonly NvidiaGpuDeviceDto[],
  grant: NvidiaGpuGrant | null | undefined,
): NvidiaGpuDeviceDto[] {
  // Callers that already received a grant-filtered device list omit `grant`.
  // Treating that omission as an empty grant hid every card.
  if (!grant) return [...inventory];
  if (grant.pciAddresses.length === 0) return [];
  const allowed = new Set(grant.pciAddresses.map(normalizePci));
  return inventory.filter((gpu) => allowed.has(normalizePci(gpu.pciAddress)));
}

export function gpuDisplayLabel(
  gpu: { index: number | null; pciAddress: string },
): string {
  return gpu.index === null ? gpu.pciAddress : `GPU ${gpu.index}`;
}

export function formatGpuSelectionLabel(
  pciAddresses: readonly string[],
  inventory: ReadonlyArray<{ index: number | null; pciAddress: string; model: string }>,
): string {
  if (pciAddresses.length === 0) return '无';
  const byPci = new Map(inventory.map((gpu) => [normalizePci(gpu.pciAddress), gpu]));
  return pciAddresses.map((pci) => {
    const gpu = byPci.get(normalizePci(pci));
    return gpu ? gpuDisplayLabel(gpu) : pci;
  }).join(', ');
}

export function samePciSelection(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right.map(normalizePci));
  return left.every((item) => rightSet.has(normalizePci(item)));
}

/**
 * Default-all seeding. Returns the list to write, or null when the current
 * value should stay (already applied, or the user has edited it).
 */
export function nextDefaultGpuSelection(
  serverId: string,
  available: readonly string[],
  value: readonly string[],
  previous: { serverId: string; addresses: readonly string[] } | null,
): string[] | null {
  if (
    previous?.serverId === serverId
    && samePciSelection(previous.addresses, available)
  ) {
    return null;
  }
  if (previous?.serverId === serverId && !samePciSelection(value, previous.addresses)) {
    return null;
  }
  if (samePciSelection(value, available)) return null;
  return [...available];
}

function normalizePci(value: string): string {
  return canonicalPciAddress(value) ?? value.trim().toLowerCase();
}
