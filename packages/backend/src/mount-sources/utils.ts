export function dataDiskDisplayName(mountPoint: string, label: string | null | undefined): string {
  if (label) return label;
  const parts = mountPoint.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? mountPoint;
}
