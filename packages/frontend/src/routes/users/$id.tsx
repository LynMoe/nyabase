import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { Capability } from '@nyabase/common';
import { RequireAnyCapability } from '../../components/require-capability.js';
import { parseUserDetailTab } from '../../lib/user-detail.js';

export const Route = createFileRoute('/users/$id')({
  component: UserDetailRoute,
  validateSearch: (search: Record<string, unknown>) => ({
    tab: parseUserDetailTab(search.tab),
  }),
});

const LazyUserDetailPage = lazyRouteComponent(() => import('../../pages/user-detail-page.js'));

function UserDetailRoute() {
  return (
    <RequireAnyCapability capabilities={[Capability.ManageUsers, Capability.ManageGrants]}>
      <LazyUserDetailPage />
    </RequireAnyCapability>
  );
}
