import { createFileRoute } from '@tanstack/react-router';
import { RequireAccess } from '../../components/require-capability.js';
import { ACCESS } from '../../lib/route-access.js';
import UsagePage from '../../pages/usage-page.js';

export const Route = createFileRoute('/servers/usage')({
  component: AdminUsageRoute,
  validateSearch: (search: Record<string, unknown>) => ({
    serverId: typeof search.serverId === 'string' ? search.serverId : undefined,
  }),
});

function AdminUsageRoute() {
  const { serverId } = Route.useSearch();
  return (
    <RequireAccess rule={ACCESS.adminUsage}>
      <UsagePage scope="all" initialServerId={serverId} />
    </RequireAccess>
  );
}
