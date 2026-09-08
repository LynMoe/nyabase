import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { Capability } from '@nyabase/common';
import { RequireCapability } from '../../components/require-capability.js';
import { parseImageDetailTab } from '../../lib/image-detail.js';

export const Route = createFileRoute('/images/$id')({
  component: ImageDetailRoute,
  validateSearch: (search: Record<string, unknown>) => ({
    tab: parseImageDetailTab(search.tab),
  }),
});

const LazyImageDetailPage = lazyRouteComponent(() => import('../../pages/image-detail-page.js'));

function ImageDetailRoute() {
  return (
    <RequireCapability capability={Capability.ManageImages}>
      <LazyImageDetailPage />
    </RequireCapability>
  );
}
