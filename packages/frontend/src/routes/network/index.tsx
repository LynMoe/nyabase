import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { RequireAccess } from '../../components/require-access.js';
import { ACCESS } from '../../lib/route-access.js';
import { parseNetworkTab } from '../../pages/network-page/tabs.js';

export const Route = createFileRoute('/network/')({
  component: NetworkRoute,
  validateSearch: (search: Record<string, unknown>) => ({
    tab: parseNetworkTab(search.tab),
  }),
});

const LazyNetworkPage = lazyRouteComponent(() => import('../../pages/network-page.js'));

function NetworkRoute() {
  return <RequireAccess rule={ACCESS.network}><LazyNetworkPage /></RequireAccess>;
}
