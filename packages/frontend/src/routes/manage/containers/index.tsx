import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { RequireAccess } from '../../../components/require-capability.js';
import { ACCESS } from '../../../lib/route-access.js';

export const Route = createFileRoute('/manage/containers/')({
  component: ManageContainersRoute,
});

const LazyManageContainersPage = lazyRouteComponent(() => import('../../../pages/manage-containers-page.js'));

function ManageContainersRoute() {
  return (
    <RequireAccess rule={ACCESS.manageContainers}>
      <LazyManageContainersPage />
    </RequireAccess>
  );
}
