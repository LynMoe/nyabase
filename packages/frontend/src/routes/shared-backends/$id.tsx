import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { RequireAccess } from '../../components/require-capability.js';
import { ACCESS } from '../../lib/route-access.js';
import { parseSharedBackendDetailTab } from '../../lib/detail-tabs.js';

export const Route = createFileRoute('/shared-backends/$id')({
  component: SharedBackendDetailRoute,
  validateSearch: (search: Record<string, unknown>) => ({
    tab: parseSharedBackendDetailTab(search.tab),
  }),
});

const LazySharedBackendDetailPage = lazyRouteComponent(
  () => import('../../pages/shared-backend-detail-page.js'),
);

function SharedBackendDetailRoute() {
  return (
    <RequireAccess rule={ACCESS.sharedBackends}>
      <LazySharedBackendDetailPage />
    </RequireAccess>
  );
}
