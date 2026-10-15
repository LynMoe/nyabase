import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { RequireAccess } from '../../components/require-capability.js';
import { ACCESS } from '../../lib/route-access.js';

export const Route = createFileRoute('/ip-pools/')({
  component: IpPoolsRoute,
});

const LazyIpPoolsPage = lazyRouteComponent(() => import('../../pages/ip-pools-page.js'));

function IpPoolsRoute() {
  return <RequireAccess rule={ACCESS.ipPools}><LazyIpPoolsPage /></RequireAccess>;
}
