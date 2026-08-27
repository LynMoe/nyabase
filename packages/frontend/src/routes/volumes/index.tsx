import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';

export const Route = createFileRoute('/volumes/')({
  component: lazyRouteComponent(() => import('../../pages/volumes-page.js')),
});
