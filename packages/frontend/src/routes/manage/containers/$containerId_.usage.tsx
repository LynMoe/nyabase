import { createFileRoute } from '@tanstack/react-router';
import { RequireAccess } from '../../../components/require-capability.js';
import { ACCESS } from '../../../lib/route-access.js';
import ContainerUsagePage from '../../../pages/container-usage-page.js';

export const Route = createFileRoute('/manage/containers/$containerId_/usage')({
  component: ManageContainerUsageRoute,
});

function ManageContainerUsageRoute() {
  const { containerId } = Route.useParams();
  return (
    <RequireAccess rule={ACCESS.manageContainers}>
      <ContainerUsagePage containerId={containerId} scope="all" />
    </RequireAccess>
  );
}
