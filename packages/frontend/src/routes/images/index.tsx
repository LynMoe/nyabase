import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { Capability } from '@nyabase/common';
import { RequireCapability } from '../../components/require-capability.js';

export const Route = createFileRoute('/images/')({
  component: ImagesRoute,
});

const LazyImagesPage = lazyRouteComponent(() => import('../../pages/images-page.js'));

function ImagesRoute() {
  return (
    <RequireCapability capability={Capability.ManageImages}>
      <LazyImagesPage />
    </RequireCapability>
  );
}
