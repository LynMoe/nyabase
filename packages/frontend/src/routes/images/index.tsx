import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { RequireAccess } from '../../components/require-capability.js';
import { ACCESS } from '../../lib/route-access.js';

export const Route = createFileRoute('/images/')({
  component: ImagesRoute,
});

const LazyImagesPage = lazyRouteComponent(() => import('../../pages/images-page.js'));

function ImagesRoute() {
  return (
    <RequireAccess rule={ACCESS.images}>
      <LazyImagesPage />
    </RequireAccess>
  );
}
