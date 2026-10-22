import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { RequireAccess } from '../../components/require-access.js';
import { ACCESS } from '../../lib/route-access.js';

const PAGE_SIZES = [25, 50, 100] as const;

export type AuditPageSize = (typeof PAGE_SIZES)[number];

export type AuditSearch = {
  page: number;
  pageSize: AuditPageSize;
  action?: string;
  targetType?: string;
};

function parseFilterValue(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z][a-z0-9_.-]{0,63}$/.test(value) ? value : undefined;
}

function parseAuditPage(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return 0;
}

function parseAuditPageSize(value: unknown): AuditPageSize {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : Number.NaN;
  const size = PAGE_SIZES.find((candidate) => candidate === parsed);
  if (size !== undefined) {
    return size;
  }
  return 50;
}

export const Route = createFileRoute('/audit/')({
  validateSearch: (search: Record<string, unknown>): AuditSearch => ({
    page: parseAuditPage(search.page),
    pageSize: parseAuditPageSize(search.pageSize),
    action: parseFilterValue(search.action),
    targetType: parseFilterValue(search.targetType),
  }),
  component: AuditRoute,
});

const LazyAuditPage = lazyRouteComponent(() => import('../../pages/audit-page.js'));

function AuditRoute() {
  return (
    <RequireAccess rule={ACCESS.audit}>
      <LazyAuditPage />
    </RequireAccess>
  );
}
