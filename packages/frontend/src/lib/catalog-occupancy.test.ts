import { describe, expect, it } from 'vitest';
import type { SharedVolumeCatalogOccupancy } from '@nyabase/common';
import {
  catalogOccupancyLabel,
  occupancyForCatalogItem,
  shouldSkipCatalogInspectRow,
} from './catalog-occupancy.js';

const CASES: Array<{
  pgCatalogState: 'ensuring' | 'present' | 'absent';
  incusPresent: boolean | null;
  hasAttachment: boolean;
  occupancy: SharedVolumeCatalogOccupancy | 'skip';
  label: string | null;
}> = [
  {
    pgCatalogState: 'absent',
    incusPresent: false,
    hasAttachment: false,
    occupancy: 'skip',
    label: null,
  },
  {
    pgCatalogState: 'present',
    incusPresent: null,
    hasAttachment: true,
    occupancy: 'unreachable',
    label: '不可达',
  },
  {
    pgCatalogState: 'present',
    incusPresent: false,
    hasAttachment: true,
    occupancy: 'dangling_pg',
    label: 'PG 有 Incus 无',
  },
  {
    pgCatalogState: 'ensuring',
    incusPresent: false,
    hasAttachment: false,
    occupancy: 'dangling_pg',
    label: 'PG 有 Incus 无',
  },
  {
    pgCatalogState: 'absent',
    incusPresent: true,
    hasAttachment: false,
    occupancy: 'dangling_incus',
    label: 'Incus 有 PG 无',
  },
  {
    pgCatalogState: 'present',
    incusPresent: true,
    hasAttachment: true,
    occupancy: 'in_use',
    label: '使用中',
  },
  {
    pgCatalogState: 'present',
    incusPresent: true,
    hasAttachment: false,
    occupancy: 'cache',
    label: '缓存（无挂载）',
  },
  {
    pgCatalogState: 'ensuring',
    incusPresent: true,
    hasAttachment: false,
    occupancy: 'ensuring',
    label: '登记中',
  },
];

describe('catalog occupancy matcher', () => {
  it.each(CASES)(
    '$pgCatalogState / incus=$incusPresent / attached=$hasAttachment → $occupancy',
    (row) => {
      expect(occupancyForCatalogItem({
        pgCatalogState: row.pgCatalogState,
        incusPresent: row.incusPresent,
        hasAttachment: row.hasAttachment,
      })).toBe(row.occupancy);
      expect(shouldSkipCatalogInspectRow(row)).toBe(row.occupancy === 'skip');
      if (row.occupancy === 'skip') {
        expect(row.label).toBeNull();
        return;
      }
      expect(catalogOccupancyLabel(row.occupancy)).toBe(row.label);
    },
  );
});
