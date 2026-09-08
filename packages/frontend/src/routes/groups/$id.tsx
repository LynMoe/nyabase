import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { Capability } from '@nyabase/common';
import { RequireAnyCapability } from '../../components/require-capability.js';
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
    <RequireAnyCapability capabilities={[Capability.ManageGroups, Capability.ManageGrants]}>
      <LazyGroupDetailPage />
    </RequireAnyCapability>
  );
}
