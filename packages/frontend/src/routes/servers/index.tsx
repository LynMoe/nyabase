import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { RequireAccess } from '../../components/require-capability.js';
import { ACCESS } from '../../lib/route-access.js';

export const Route = createFileRoute('/servers/')({
  component: ServersRoute,
});

const LazyServersPage = lazyRouteComponent(() => import('../../pages/servers-page.js'));

function ServersRoute() {
  return (
    <RequireAccess rule={ACCESS.servers}>
      <LazyServersPage />
    </RequireAccess>
  );
}
