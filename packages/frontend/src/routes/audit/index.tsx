import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { Capability } from '@nyabase/common';
import { RequireCapability } from '../../components/require-capability.js';

const PAGE_SIZES = [25, 50, 100] as const;

export type AuditPageSize = (typeof PAGE_SIZES)[number];

export type AuditSearch = {
  page: number;
  pageSize: AuditPageSize;
};

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
  if (parsed === 25 || parsed === 50 || parsed === 100) {
    return parsed;
  }
  return 50;
}

export const Route = createFileRoute('/audit/')({
  validateSearch: (search: Record<string, unknown>): AuditSearch => ({
    page: parseAuditPage(search.page),
    pageSize: parseAuditPageSize(search.pageSize),
  }),
  component: AuditRoute,
});

const LazyAuditPage = lazyRouteComponent(() => import('../../pages/audit-page.js'));

function AuditRoute() {
  return (
    <RequireCapability capability={Capability.ViewAudit}>
      <LazyAuditPage />
    </RequireCapability>
  );
}
