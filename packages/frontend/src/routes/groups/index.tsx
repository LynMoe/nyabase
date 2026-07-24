import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { Capability } from '@nyabase/common';
import { RequireAnyCapability } from '../../components/require-capability.js';

export const Route = createFileRoute('/groups/')({
  component: GroupsRoute,
});

const LazyGroupsPage = lazyRouteComponent(() => import('../../pages/groups-page.js'));

function GroupsRoute() {
  return (
    <RequireAnyCapability capabilities={[Capability.ManageGroups, Capability.ManageGrants]}>
      <LazyGroupsPage />
    </RequireAnyCapability>
  );
}
