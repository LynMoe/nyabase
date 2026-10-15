import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { RequireAccess } from '../../components/require-capability.js';
import { ACCESS } from '../../lib/route-access.js';

export const Route = createFileRoute('/groups/')({
  component: GroupsRoute,
});

const LazyGroupsPage = lazyRouteComponent(() => import('../../pages/groups-page.js'));

function GroupsRoute() {
  return (
    <RequireAccess rule={ACCESS.groups}>
      <LazyGroupsPage />
    </RequireAccess>
  );
}
