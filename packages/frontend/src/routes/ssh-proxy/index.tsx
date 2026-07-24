import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { RequireAnyCapability } from '../../components/require-capability.js';
import { SSH_PROXY_STATUS_CAPABILITIES } from '../../lib/ssh-proxy-access.js';

export const Route = createFileRoute('/ssh-proxy/')({
  component: SshProxyRoute,
});

const LazySshProxyPage = lazyRouteComponent(() => import('../../pages/ssh-proxy-page.js'));

function SshProxyRoute() {
  return (
    <RequireAnyCapability capabilities={SSH_PROXY_STATUS_CAPABILITIES}>
      <LazySshProxyPage />
    </RequireAnyCapability>
  );
}
