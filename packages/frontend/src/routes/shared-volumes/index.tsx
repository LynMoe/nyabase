import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';

export const Route = createFileRoute('/shared-volumes/')({
  component: lazyRouteComponent(() => import('../../pages/shared-volumes-page.js')),
});
