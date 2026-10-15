import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { RequireAccess } from '../../components/require-capability.js';
import { ACCESS } from '../../lib/route-access.js';

export const Route = createFileRoute('/ssh-proxy/')({
  component: SshProxyRoute,
});

const LazySshProxyPage = lazyRouteComponent(() => import('../../pages/ssh-proxy-page.js'));

function SshProxyRoute() {
  return (
    <RequireAccess rule={ACCESS.sshProxy}>
      <LazySshProxyPage />
    </RequireAccess>
  );
}
