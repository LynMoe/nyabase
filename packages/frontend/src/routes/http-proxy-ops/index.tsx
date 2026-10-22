import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { RequireAccess } from '../../components/require-access.js';
import { ACCESS } from '../../lib/route-access.js';

export const Route = createFileRoute('/http-proxy-ops/')({
  component: HttpProxyOpsRoute,
});

const LazyHttpProxyOpsPage = lazyRouteComponent(() => import('../../pages/http-proxy-ops-page.js'));

function HttpProxyOpsRoute() {
  return (
    <RequireAccess rule={ACCESS.httpProxyOps}>
      <LazyHttpProxyOpsPage />
    </RequireAccess>
  );
}
