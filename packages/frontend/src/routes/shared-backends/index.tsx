import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { RequireAccess } from '../../components/require-access.js';
import { ACCESS } from '../../lib/route-access.js';

export const Route = createFileRoute('/shared-backends/')({
  component: SharedBackendsRoute,
});

const LazySharedBackendsPage = lazyRouteComponent(() => import('../../pages/shared-backends-page.js'));

function SharedBackendsRoute() {
  return <RequireAccess rule={ACCESS.sharedBackends}><LazySharedBackendsPage /></RequireAccess>;
}
