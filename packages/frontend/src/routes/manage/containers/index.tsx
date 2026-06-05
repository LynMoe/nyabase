import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { Capability } from '@nyabase/common';
import { RequireCapability } from '../../../components/require-capability.js';

export const Route = createFileRoute('/manage/containers/')({
  component: ManageContainersRoute,
});

const LazyManageContainersPage = lazyRouteComponent(() => import('../../../pages/manage-containers-page.js'));

function ManageContainersRoute() {
  return (
    <RequireCapability capability={Capability.ManageContainersAny}>
      <LazyManageContainersPage />
    </RequireCapability>
  );
}
