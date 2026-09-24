import { createFileRoute } from '@tanstack/react-router';
import { Capability } from '@nyabase/common';
import { RequireCapability } from '../../components/require-capability.js';
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
    <RequireCapability capability={Capability.ViewMetricsAll}>
      <UsagePage mode="admin" initialServerId={serverId} />
    </RequireCapability>
  );
}
