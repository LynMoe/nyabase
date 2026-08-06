import { Module, forwardRef } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ContainersModule } from '../containers/containers.module.js';
import { DataDirsModule } from '../datadirs/datadirs.module.js';
import { GroupsModule } from '../groups/groups.module.js';
import { NyabaseConfigModule } from '../config/nyabase-config.module.js';
import { AccessModule } from './access.module.js';
import { AdminUserServerPurgeController } from './admin-user-server-purge.controller.js';
import { GrantExpiryEnforcementRepository } from './grant-expiry-enforcement.repository.js';
import { GrantExpiryWorkerService } from './grant-expiry-worker.service.js';
import { UserServerResourcePurgeService } from './user-server-resource-purge.service.js';

@Module({
  imports: [
    NyabaseConfigModule,
    forwardRef(() => AccessModule),
    forwardRef(() => AuthModule),
    forwardRef(() => AuditModule),
    forwardRef(() => ContainersModule),
    forwardRef(() => DataDirsModule),
    forwardRef(() => GroupsModule),
  ],
  controllers: [AdminUserServerPurgeController],
  providers: [
    GrantExpiryEnforcementRepository,
    UserServerResourcePurgeService,
    GrantExpiryWorkerService,
  ],
  exports: [
    GrantExpiryEnforcementRepository,
    UserServerResourcePurgeService,
    GrantExpiryWorkerService,
  ],
})
export class GrantExpiryModule {}
