import { Module } from '@nestjs/common';
import { ContainersModule } from '../containers/containers.module.js';
import { GrantsModule } from '../grants/grants.module.js';
import { ProxySnapshotNotifierModule } from '../proxy-snapshots/proxy-snapshot-notifier.module.js';
import { ReconcileModule } from '../reconcile/reconcile.module.js';
import { VolumesModule } from '../volumes/volumes.module.js';
import { AccessLapseProcessor } from './access-lapse.processor.js';
import { AccessLapseRepository } from './access-lapse.repository.js';
import { AdminCatalogController } from './admin-catalog.controller.js';
import { AdminUserServerPurgeController } from './admin-user-server-purge.controller.js';
import { CatalogPersistence } from './catalog.persistence.js';
import { UserServerResourcePurgeService } from './user-server-resource-purge.service.js';

/** Administration of access: the access-lapse processor, user-server purge and selector catalog. */
@Module({
  imports: [ContainersModule, GrantsModule, ProxySnapshotNotifierModule, ReconcileModule, VolumesModule],
  controllers: [AdminUserServerPurgeController, AdminCatalogController],
  providers: [
    CatalogPersistence,
    UserServerResourcePurgeService,
    AccessLapseRepository,
    AccessLapseProcessor,
  ],
})
export class AccessModule {}
