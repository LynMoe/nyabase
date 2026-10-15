import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { RequireAccess } from '../../components/require-capability.js';
import { ACCESS } from '../../lib/route-access.js';
import { parseGroupDetailTab } from '../../lib/group-detail.js';

export const Route = createFileRoute('/groups/$id')({
  component: GroupDetailRoute,
  validateSearch: (search: Record<string, unknown>) => ({
    tab: parseGroupDetailTab(search.tab),
  }),
});

const LazyGroupDetailPage = lazyRouteComponent(() => import('../../pages/group-detail-page.js'));

function GroupDetailRoute() {
  return (
    <RequireAccess rule={ACCESS.groups}>
      <LazyGroupDetailPage />
    </RequireAccess>
  );
}
