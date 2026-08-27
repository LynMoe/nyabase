import { Module, forwardRef } from '@nestjs/common';
import { GroupsService } from './groups.service.js';
import { GroupsController } from './groups.controller.js';
import { UserGrantsController } from './user-grants.controller.js';
import { MeAccessController } from './me-access.controller.js';
import { AuthModule } from '../auth/auth.module.js';
import { AccessModule } from '../access/access.module.js';
import { AuditModule } from '../audit/audit.module.js';

@Module({
  imports: [
    AuthModule,
    forwardRef(() => AccessModule),
    forwardRef(() => AuditModule),
  ],
  providers: [GroupsService],
  controllers: [GroupsController, UserGrantsController, MeAccessController],
  exports: [GroupsService],
})
export class GroupsModule {}
