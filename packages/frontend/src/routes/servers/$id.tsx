import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { Capability } from '@nyabase/common';
import { RequireCapability } from '../../components/require-capability.js';

export const Route = createFileRoute('/servers/$id')({
  component: ServerDetailRoute,
});

const LazyServerDetailPage = lazyRouteComponent(() => import('../../pages/server-detail-page.js'));

function ServerDetailRoute() {
  return (
    <RequireCapability capability={Capability.ManageServers}>
      <LazyServerDetailPage />
    </RequireCapability>
  );
}
