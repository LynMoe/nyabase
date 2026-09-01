import type { SharedVolumeCatalogOccupancy } from '@nyabase/common';

export type CatalogPgState = 'ensuring' | 'present' | 'absent';

export const CATALOG_OCCUPANCY_LABELS: Record<SharedVolumeCatalogOccupancy, string> = {
  in_use: '使用中',
  cache: '缓存（无挂载）',
  ensuring: '登记中',
  dangling_incus: 'Incus 有 PG 无',
  dangling_pg: 'PG 有 Incus 无',
  unreachable: '不可达',
};

export function catalogOccupancyLabel(occupancy: SharedVolumeCatalogOccupancy): string {
  return CATALOG_OCCUPANCY_LABELS[occupancy];
}

export function shouldSkipCatalogInspectRow(input: {
  pgCatalogState: CatalogPgState;
  incusPresent: boolean | null;
}): boolean {
  return input.pgCatalogState === 'absent' && input.incusPresent === false;
}

/** Same matcher as the inspect API: first match wins; skip never appears in the table. */
export function occupancyForCatalogItem(input: {
  pgCatalogState: CatalogPgState;
  incusPresent: boolean | null;
  hasAttachment: boolean;
}): SharedVolumeCatalogOccupancy | 'skip' {
  if (shouldSkipCatalogInspectRow(input)) return 'skip';
  if (input.incusPresent === null) return 'unreachable';
  if (
    (input.pgCatalogState === 'ensuring' || input.pgCatalogState === 'present')
    && input.incusPresent === false
  ) {
    return 'dangling_pg';
  }
  if (input.pgCatalogState === 'absent' && input.incusPresent === true) return 'dangling_incus';
  if (input.incusPresent === true && input.hasAttachment) return 'in_use';
  if (input.incusPresent === true && input.pgCatalogState === 'present') return 'cache';
  if (input.incusPresent === true && input.pgCatalogState === 'ensuring') return 'ensuring';
  throw new Error('shared catalog occupancy matcher is not exhaustive');
}
