import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { Capability } from '@nyabase/common';
import { RequireCapability } from '../../../components/require-capability.js';

export const Route = createFileRoute('/manage/remote-fs/')({
  component: ManageRemoteFsRoute,
});

const LazyManageRemoteFsPage = lazyRouteComponent(() => import('../../../pages/manage-remote-fs-page.js'));

function ManageRemoteFsRoute() {
  return (
    <RequireCapability capability={Capability.ManageServers}>
      <LazyManageRemoteFsPage />
    </RequireCapability>
  );
}
