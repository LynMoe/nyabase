import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { RequireAccess } from '../../components/require-access.js';
import { ACCESS } from '../../lib/route-access.js';

export const Route = createFileRoute('/container-scripts/')({
  component: ContainerScriptsRoute,
});

const LazyContainerScriptsPage = lazyRouteComponent(() => import('../../pages/container-scripts-page.js'));

function ContainerScriptsRoute() {
  return (
    <RequireAccess rule={ACCESS.containerScripts}>
      <LazyContainerScriptsPage />
    </RequireAccess>
  );
}
