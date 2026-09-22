import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';

export const Route = createFileRoute('/quota/')({
  component: lazyRouteComponent(() => import('../../pages/quota-page.js')),
});
