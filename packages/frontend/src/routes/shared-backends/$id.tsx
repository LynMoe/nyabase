import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { Capability } from '@nyabase/common';
import { RequireCapability } from '../../components/require-capability.js';
import { parseSharedBackendDetailTab } from '../../lib/shared-backend-detail.js';

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
    <RequireCapability capability={Capability.ManageSharedBackends}>
      <LazySharedBackendDetailPage />
    </RequireCapability>
  );
}
