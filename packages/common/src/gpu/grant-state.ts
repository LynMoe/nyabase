/** Compact grant chip. A missing or empty PCI list is omitted (never `0 张 GPU`). */
export function formatGpuGrantSummary(
  pciAddresses: readonly string[] | null | undefined,
): string | null {
  if (!pciAddresses || pciAddresses.length === 0) return null;
  return `${pciAddresses.length} 张 GPU`;
}
