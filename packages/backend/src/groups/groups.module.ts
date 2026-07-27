import { Module, forwardRef } from '@nestjs/common';
import { GroupsService } from './groups.service.js';
import { GroupsController } from './groups.controller.js';
import { UserGrantsController } from './user-grants.controller.js';
import { MeAccessController } from './me-access.controller.js';
import { AccessModule } from '../access/access.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { QuotaModule } from '../quota/quota.module.js';
import { MountSourcesModule } from '../mount-sources/mount-sources.module.js';
import { ProxySnapshotNotifierModule } from '../proxy-snapshots/proxy-snapshot-notifier.module.js';

@Module({
  imports: [
    forwardRef(() => AccessModule),
    forwardRef(() => AuthModule),
    forwardRef(() => AuditModule),
    forwardRef(() => QuotaModule),
    forwardRef(() => MountSourcesModule),
    ProxySnapshotNotifierModule,
  ],
  providers: [GroupsService],
  controllers: [GroupsController, UserGrantsController, MeAccessController],
  exports: [GroupsService],
})
export class GroupsModule {}
