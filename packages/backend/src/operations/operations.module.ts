import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccessModule } from '../access/access.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { CommandHooksModule } from '../command-hooks/command-hooks.module.js';
import { ContainerDesiredSpecEntity } from '../entities/container-desired-spec.entity.js';
import { ContainerLifecycleEntity } from '../entities/container-lifecycle.entity.js';
import { ContainerMountEntity } from '../entities/container-mount.entity.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { DataDirectoryEntity } from '../entities/data-directory.entity.js';
import { DataDiskEntity } from '../entities/data-disk.entity.js';
import { GpuAllocationEntity } from '../entities/gpu-allocation.entity.js';
import { MountSourceGrantEntity } from '../entities/mount-source-grant.entity.js';
import { OperationEntity } from '../entities/operation.entity.js';
import { QuotaDesiredEntity } from '../entities/quota-desired.entity.js';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { ResourceLockEntity } from '../entities/resource-lock.entity.js';
import { AgentGatewayModule } from '../gateway/agent-gateway.module.js';
import { AdminOperationsController } from './admin-operations.controller.js';
import { OperationDomainApplierService } from './operation-domain-applier.service.js';
import { OperationQueueWorkerService } from './operation-queue-worker.service.js';
import { OperationReportUnlockService } from './operation-report-unlock.service.js';
import { OperationsController } from './operations.controller.js';
import { OperationsService } from './operations.service.js';
import { ResourceKeyService } from './resource-key.service.js';
import { ResourceLockService } from './resource-lock.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      OperationEntity,
      ResourceLockEntity,
      ContainerEntity,
      ContainerDesiredSpecEntity,
      ContainerLifecycleEntity,
      ContainerMountEntity,
      DataDiskEntity,
      RemoteFsMountEntity,
      RemoteFsServerAssignmentEntity,
      QuotaDesiredEntity,
      DataDirectoryEntity,
      GpuAllocationEntity,
      MountSourceGrantEntity,
    ]),
    AuthModule,
    AccessModule,
    forwardRef(() => AgentGatewayModule),
    forwardRef(() => CommandHooksModule),
  ],
  providers: [
    OperationsService,
    OperationQueueWorkerService,
    OperationReportUnlockService,
    OperationDomainApplierService,
    ResourceLockService,
    ResourceKeyService,
  ],
  controllers: [OperationsController, AdminOperationsController],
  exports: [
    OperationsService,
    OperationReportUnlockService,
    ResourceLockService,
    ResourceKeyService,
  ],
})
export class OperationsModule {}
