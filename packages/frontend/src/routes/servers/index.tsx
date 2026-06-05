import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { Capability } from '@nyabase/common';
import { RequireCapability } from '../../components/require-capability.js';

export const Route = createFileRoute('/servers/')({
  component: ServersRoute,
});

const LazyServersPage = lazyRouteComponent(() => import('../../pages/servers-page.js'));

function ServersRoute() {
  return (
    <RequireCapability capability={Capability.ManageServers}>
      <LazyServersPage />
    </RequireCapability>
  );
}
