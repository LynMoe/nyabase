import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { Capability } from '@nyabase/common';
import { RequireCapability } from '../../components/require-capability.js';

export const Route = createFileRoute('/groups/$id')({
  component: GroupDetailRoute,
});

const LazyGroupDetailPage = lazyRouteComponent(() => import('../../pages/group-detail-page.js'));

function GroupDetailRoute() {
  return (
    <RequireCapability capability={Capability.ManageGroups}>
      <LazyGroupDetailPage />
    </RequireCapability>
  );
}
