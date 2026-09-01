import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { Capability } from '@nyabase/common';
import { RequireCapability } from '../../../components/require-capability.js';

export const Route = createFileRoute('/manage/shared-volumes/')({
  component: ManageSharedVolumesRoute,
});

const LazyManageSharedVolumesPage = lazyRouteComponent(
  () => import('../../../pages/manage-shared-volumes-page.js'),
);

function ManageSharedVolumesRoute() {
  return (
    <RequireCapability capability={Capability.ManageSharedVolumes}>
      <LazyManageSharedVolumesPage />
    </RequireCapability>
  );
}
