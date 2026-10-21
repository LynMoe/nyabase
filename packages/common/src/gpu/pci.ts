export const MAX_GPU_DEVICES = 256;

const PCI_ADDRESS_RE = /^(?:[0-9a-f]{4}|[0-9a-f]{8}):[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$/i;

export function canonicalPciAddress(value: string): string | null {
  const normalized = value.toLowerCase();
  if (!PCI_ADDRESS_RE.test(normalized)) return null;
  const domainEnd = normalized.indexOf(':');
  const domain = normalized.slice(0, domainEnd).padStart(8, '0');
  return `${domain}${normalized.slice(domainEnd)}`;
}

/** Incus physical GPU `pci` option uses a 4-hex domain (sysfs style). */
export function toIncusPciAddress(canonical: string): string {
  const domainEnd = canonical.indexOf(':');
  if (domainEnd <= 0) return canonical;
  return `${canonical.slice(0, domainEnd).slice(-4)}${canonical.slice(domainEnd)}`;
}

export function isWildcardPciAddress(value: string): boolean {
  return value.includes('*');
}
