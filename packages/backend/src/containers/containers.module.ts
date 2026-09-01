import { Module, forwardRef } from '@nestjs/common';
import { ContainersController } from './containers.controller.js';
import { AdminContainersController } from './admin-containers.controller.js';
import { ContainerActionPolicyService } from './container-action-policy.service.js';
import { ContainerControlService } from './container-control.service.js';
import { ContainerControlRepository } from './container-control.repository.js';
import { AuthModule } from '../auth/auth.module.js';
import { AccessModule } from '../access/access.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { RuntimeModule } from '../runtime/runtime.module.js';
import { IpPoolsModule } from '../ip-pools/ip-pools.module.js';
import { SshModule } from '../ssh/ssh.module.js';
import { VolumesModule } from '../volumes/volumes.module.js';

@Module({
  imports: [
    AuthModule,
    AccessModule,
    AuditModule,
    RuntimeModule,
    IpPoolsModule,
    forwardRef(() => SshModule),
    forwardRef(() => VolumesModule),
  ],
  providers: [
    ContainerActionPolicyService,
    ContainerControlService,
    ContainerControlRepository,
  ],
  controllers: [ContainersController, AdminContainersController],
  exports: [
    ContainerActionPolicyService,
    ContainerControlService,
    ContainerControlRepository,
  ],
})
export class ContainersModule {}
