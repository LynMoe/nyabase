import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { RequireAccess } from '../../components/require-access.js';
import { ACCESS } from '../../lib/route-access.js';
import { parseServerDetailTab } from '../../pages/server-detail-page.js';

export const Route = createFileRoute('/servers/$id')({
  component: ServerDetailRoute,
  validateSearch: (search: Record<string, unknown>) => ({
    tab: parseServerDetailTab(search.tab),
  }),
});

const LazyServerDetailPage = lazyRouteComponent(() => import('../../pages/server-detail-page.js'));

function ServerDetailRoute() {
  return (
    <RequireAccess rule={ACCESS.servers}>
      <LazyServerDetailPage />
    </RequireAccess>
  );
}
