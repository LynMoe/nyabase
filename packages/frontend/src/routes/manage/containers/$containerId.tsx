import { createFileRoute } from '@tanstack/react-router';
import { Capability } from '@nyabase/common';
import { RequireCapability } from '../../../components/require-capability.js';
import { AdminContainerDetailPage, parseDetailTab } from '../../../pages/container-detail-page.js';

export const Route = createFileRoute('/manage/containers/$containerId')({
  component: ManageContainerDetailRoute,
  validateSearch: (search: Record<string, unknown>) => ({
    tab: parseDetailTab(search.tab),
  }),
});

function ManageContainerDetailRoute() {
  return (
    <RequireCapability capability={Capability.ManageContainersAny}>
      <AdminContainerDetailPage />
    </RequireCapability>
  );
}
