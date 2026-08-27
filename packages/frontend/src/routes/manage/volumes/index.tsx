import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { Capability } from '@nyabase/common';
import { RequireCapability } from '../../../components/require-capability.js';

export const Route = createFileRoute('/manage/volumes/')({
  component: ManageVolumesRoute,
});

const LazyManageVolumesPage = lazyRouteComponent(() => import('../../../pages/manage-volumes-page.js'));

function ManageVolumesRoute() {
  return (
    <RequireCapability capability={Capability.ManageVolumes}>
      <LazyManageVolumesPage />
    </RequireCapability>
  );
}
