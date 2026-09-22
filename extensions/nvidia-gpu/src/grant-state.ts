import { NVIDIA_GPU_EXTENSION_ID } from './id.js';
import { zNvidiaGpuGrant, type NvidiaGpuGrant } from './schema.js';

export type { NvidiaGpuGrant };

/** Compact grant chip. A missing or empty PCI list is omitted (never `0GPU`). */
export function formatGrantSummary(
  grants: Record<string, unknown> | null | undefined,
): string | null {
  const parsed = parseGrant(grants?.[NVIDIA_GPU_EXTENSION_ID]);
  if (!parsed || parsed.pciAddresses.length === 0) return null;
  return `${parsed.pciAddresses.length}GPU`;
}

export function parseGrant(value: unknown): NvidiaGpuGrant | null {
  const parsed = zNvidiaGpuGrant.safeParse(value);
  return parsed.success ? parsed.data : null;
}
