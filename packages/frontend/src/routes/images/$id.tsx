import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { RequireAccess } from '../../components/require-capability.js';
import { ACCESS } from '../../lib/route-access.js';
import { parseImageDetailTab } from '../../lib/detail-tabs.js';

export const Route = createFileRoute('/images/$id')({
  component: ImageDetailRoute,
  validateSearch: (search: Record<string, unknown>) => ({
    tab: parseImageDetailTab(search.tab),
  }),
});

const LazyImageDetailPage = lazyRouteComponent(() => import('../../pages/image-detail-page.js'));

function ImageDetailRoute() {
  return (
    <RequireAccess rule={ACCESS.images}>
      <LazyImageDetailPage />
    </RequireAccess>
  );
}
