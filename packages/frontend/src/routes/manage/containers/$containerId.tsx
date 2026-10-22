import { createFileRoute } from '@tanstack/react-router';
import { RequireAccess } from '../../../components/require-access.js';
import { ACCESS } from '../../../lib/route-access.js';
import { AdminContainerDetailPage, parseDetailTab } from '../../../pages/container-detail-page.js';

export const Route = createFileRoute('/manage/containers/$containerId')({
  component: ManageContainerDetailRoute,
  validateSearch: (search: Record<string, unknown>) => ({
    tab: parseDetailTab(search.tab),
  }),
});

function ManageContainerDetailRoute() {
  return (
    <RequireAccess rule={ACCESS.manageContainers}>
      <AdminContainerDetailPage />
    </RequireAccess>
  );
}
