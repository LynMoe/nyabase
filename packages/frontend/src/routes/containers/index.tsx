import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';

export const Route = createFileRoute('/containers/')({
  component: lazyRouteComponent(() => import('../../pages/containers-page.js')),
});
