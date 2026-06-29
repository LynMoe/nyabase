import { createFileRoute } from '@tanstack/react-router';
import { Capability } from '@nyabase/common';
import { RequireCapability } from '../../../components/require-capability.js';
import { AdminContainerDetailPage } from '../../../pages/container-detail-page.js';

export const Route = createFileRoute('/manage/containers/$containerId')({
  component: ManageContainerDetailRoute,
  validateSearch: (search: Record<string, unknown>) => ({
    tab: search.tab === 'console' ? 'console' as const : 'overview' as const,
  }),
});

function ManageContainerDetailRoute() {
  return (
    <RequireCapability capability={Capability.ManageContainersAny}>
      <AdminContainerDetailPage />
    </RequireCapability>
  );
}
