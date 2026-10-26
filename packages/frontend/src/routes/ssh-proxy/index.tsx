import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { RequireAccess } from '../../components/require-access.js';
import { ACCESS } from '../../lib/route-access.js';
import { parseSshProxyTab } from '../../pages/ssh-proxy-page/tabs.js';

export const Route = createFileRoute('/ssh-proxy/')({
  component: SshProxyRoute,
  validateSearch: (search: Record<string, unknown>) => ({
    tab: parseSshProxyTab(search.tab),
  }),
});

const LazySshProxyPage = lazyRouteComponent(() => import('../../pages/ssh-proxy-page.js'));

function SshProxyRoute() {
  return (
    <RequireAccess rule={ACCESS.sshProxy}>
      <LazySshProxyPage />
    </RequireAccess>
  );
}
