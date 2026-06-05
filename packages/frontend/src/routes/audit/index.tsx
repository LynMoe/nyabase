import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { Capability } from '@nyabase/common';
import { RequireCapability } from '../../components/require-capability.js';

export const Route = createFileRoute('/audit/')({
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
