import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { Capability } from '@nyabase/common';
import { RequireCapability } from '../../components/require-capability.js';

export const Route = createFileRoute('/storage-pools/')({
  component: StoragePoolsRoute,
});

const LazyStoragePoolsPage = lazyRouteComponent(() => import('../../pages/storage-pools-page.js'));

function StoragePoolsRoute() {
  return <RequireCapability capability={Capability.ManageStoragePools}><LazyStoragePoolsPage /></RequireCapability>;
}
