import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { RequireAccess } from '../../components/require-access.js';
import { ACCESS } from '../../lib/route-access.js';
import { parseContainerScriptSearch } from '../../lib/detail-tabs.js';

export const Route = createFileRoute('/container-scripts/$scriptId')({
  component: ContainerScriptDetailRoute,
  validateSearch: parseContainerScriptSearch,
});

const LazyContainerScriptDetailPage = lazyRouteComponent(() => import('../../pages/container-script-detail-page.js'));

function ContainerScriptDetailRoute() {
  return (
    <RequireAccess rule={ACCESS.containerScripts}>
      <LazyContainerScriptDetailPage />
    </RequireAccess>
  );
}
