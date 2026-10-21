import { Module } from '@nestjs/common';
import { ContainersModule } from '../containers/containers.module.js';
import { GroupsModule } from '../groups/groups.module.js';
import { RuntimeModule } from '../runtime/runtime.module.js';
import { VolumesModule } from '../volumes/volumes.module.js';
import { AdminCatalogController } from './admin-catalog.controller.js';
import { AdminUserServerPurgeController } from './admin-user-server-purge.controller.js';
import { CatalogPersistence } from './catalog.persistence.js';
import { GrantExpiryEnforcementRepository } from './grant-expiry-enforcement.repository.js';
import { GrantExpiryWorkerService } from './grant-expiry-worker.service.js';
import { UserServerResourcePurgeService } from './user-server-resource-purge.service.js';

/** Administration of access: grant expiry enforcement, user-server purge and selector catalog. */
@Module({
  imports: [ContainersModule, GroupsModule, RuntimeModule, VolumesModule],
  controllers: [AdminUserServerPurgeController, AdminCatalogController],
  providers: [
    CatalogPersistence,
    GrantExpiryEnforcementRepository,
    UserServerResourcePurgeService,
    GrantExpiryWorkerService,
  ],
})
export class AccessModule {}
