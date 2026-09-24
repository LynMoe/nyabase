import { createFileRoute } from '@tanstack/react-router';
import UsagePage from '../../pages/usage-page.js';

export const Route = createFileRoute('/usage/')({
  component: UsageRoute,
  validateSearch: (search: Record<string, unknown>) => ({
    serverId: typeof search.serverId === 'string' ? search.serverId : undefined,
  }),
});

function UsageRoute() {
  const { serverId } = Route.useSearch();
  return <UsagePage mode="user" initialServerId={serverId} />;
}
