import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { RequireAccess } from '../../../components/require-access.js';
import { ACCESS } from '../../../lib/route-access.js';
import { parseVolumeSearch } from '../../../components/storage/volume-detail-focus.js';

export const Route = createFileRoute('/manage/volumes/')({
  validateSearch: parseVolumeSearch,
  component: ManageVolumesRoute,
});

const LazyManageVolumesPage = lazyRouteComponent(() => import('../../../pages/manage-volumes-page.js'));

function ManageVolumesRoute() {
  return (
    <RequireAccess rule={ACCESS.manageVolumes}>
      <LazyManageVolumesPage />
    </RequireAccess>
  );
}
