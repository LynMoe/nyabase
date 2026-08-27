import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { Capability } from '@nyabase/common';
import { RequireCapability } from '../../components/require-capability.js';

export const Route = createFileRoute('/shared-backends/')({
  component: SharedBackendsRoute,
});

const LazySharedBackendsPage = lazyRouteComponent(() => import('../../pages/shared-backends-page.js'));

function SharedBackendsRoute() {
  return <RequireCapability capability={Capability.ManageSharedBackends}><LazySharedBackendsPage /></RequireCapability>;
}
