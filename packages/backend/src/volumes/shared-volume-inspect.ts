import type { SharedVolumeCatalogOccupancy } from '@nyabase/common';

export type SharedCatalogPgState = 'ensuring' | 'present' | 'absent';

export function occupancyForCatalogItem(input: {
  pgCatalogState: SharedCatalogPgState;
  incusPresent: boolean | null;
  hasAttachment: boolean;
}): SharedVolumeCatalogOccupancy | 'skip' {
  if (input.pgCatalogState === 'absent' && input.incusPresent === false) return 'skip';
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
