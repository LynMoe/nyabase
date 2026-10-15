import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { RequireAccess } from '../../components/require-capability.js';
import { ACCESS } from '../../lib/route-access.js';

export const Route = createFileRoute('/ops/')({
  component: OpsRoute,
});

const LazyOpsPage = lazyRouteComponent(() => import('../../pages/ops-page.js'));

function OpsRoute() {
  return (
    <RequireAccess rule={ACCESS.ops}>
      <LazyOpsPage />
    </RequireAccess>
  );
}
