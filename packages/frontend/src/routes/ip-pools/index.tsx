import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { Capability } from '@nyabase/common';
import { RequireCapability } from '../../components/require-capability.js';

export const Route = createFileRoute('/ip-pools/')({
  component: IpPoolsRoute,
});

const LazyIpPoolsPage = lazyRouteComponent(() => import('../../pages/ip-pools-page.js'));

function IpPoolsRoute() {
  return <RequireCapability capability={Capability.ManageIpPools}><LazyIpPoolsPage /></RequireCapability>;
}
