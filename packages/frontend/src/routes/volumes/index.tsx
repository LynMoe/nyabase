import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { parseVolumeSearch } from '../../components/storage/volume-detail-focus.js';

export const Route = createFileRoute('/volumes/')({
  validateSearch: parseVolumeSearch,
  component: lazyRouteComponent(() => import('../../pages/volumes-page.js')),
});
