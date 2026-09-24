import { createFileRoute } from '@tanstack/react-router';
import { Capability } from '@nyabase/common';
import { RequireCapability } from '../../../components/require-capability.js';
import ContainerUsagePage from '../../../pages/container-usage-page.js';

export const Route = createFileRoute('/manage/containers/$containerId_/usage')({
  component: ManageContainerUsageRoute,
});

function ManageContainerUsageRoute() {
  const { containerId } = Route.useParams();
  return (
    <RequireCapability capability={Capability.ManageContainersAny}>
      <ContainerUsagePage containerId={containerId} admin />
    </RequireCapability>
  );
}
