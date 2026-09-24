import { createFileRoute } from '@tanstack/react-router';
import ContainerUsagePage from '../../pages/container-usage-page.js';

export const Route = createFileRoute('/containers/$containerId_/usage')({
  component: ContainerUsageRoute,
});

function ContainerUsageRoute() {
  const { containerId } = Route.useParams();
  return <ContainerUsagePage containerId={containerId} admin={false} />;
}
