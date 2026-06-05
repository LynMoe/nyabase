import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccessModule } from '../access/access.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AgentCommandOutboxEntity } from '../entities/agent-command-outbox.entity.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { ContainerDesiredSpecEntity } from '../entities/container-desired-spec.entity.js';
import { ContainerLifecycleEntity } from '../entities/container-lifecycle.entity.js';
import { ContainerMountEntity } from '../entities/container-mount.entity.js';
import { DataDirectoryEntity } from '../entities/data-directory.entity.js';
import { DataDiskEntity } from '../entities/data-disk.entity.js';
import { OperationEntity } from '../entities/operation.entity.js';
import { OperationStepEntity } from '../entities/operation-step.entity.js';
import { QuotaDesiredEntity } from '../entities/quota-desired.entity.js';
import { ReconcileTaskEntity } from '../entities/reconcile-task.entity.js';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { ResourceLockEntity } from '../entities/resource-lock.entity.js';
import { SshPublicKeyEntity } from '../entities/ssh-public-key.entity.js';
import { AgentGatewayModule } from '../gateway/agent-gateway.module.js';
import { DataDirsModule } from '../datadirs/datadirs.module.js';
import { AgentCommandOutboxWorkerService } from './agent-command-outbox-worker.service.js';
import { LifecycleHookRegistryService } from './lifecycle-hook-registry.service.js';
import { AdminOperationsController } from './admin-operations.controller.js';
import { OperationOrchestratorService } from './operation-orchestrator.service.js';
import { OperationsController } from './operations.controller.js';
import { OperationsService } from './operations.service.js';
import { ReconcileTaskWorkerService } from './reconcile-task-worker.service.js';
import { ResourceLockService } from './resource-lock.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      OperationEntity,
      OperationStepEntity,
      AgentCommandOutboxEntity,
      ResourceLockEntity,
      ReconcileTaskEntity,
      ContainerEntity,
      ContainerDesiredSpecEntity,
      ContainerLifecycleEntity,
      ContainerMountEntity,
      DataDiskEntity,
      RemoteFsMountEntity,
      RemoteFsServerAssignmentEntity,
      SshPublicKeyEntity,
      QuotaDesiredEntity,
      DataDirectoryEntity,
    ]),
    AuthModule,
    AccessModule,
    forwardRef(() => AgentGatewayModule),
    forwardRef(() => DataDirsModule),
  ],
  providers: [
    OperationsService,
    OperationOrchestratorService,
    AgentCommandOutboxWorkerService,
    ResourceLockService,
    ReconcileTaskWorkerService,
    LifecycleHookRegistryService,
  ],
  controllers: [OperationsController, AdminOperationsController],
  exports: [
    OperationsService,
    OperationOrchestratorService,
    AgentCommandOutboxWorkerService,
    ResourceLockService,
    ReconcileTaskWorkerService,
    LifecycleHookRegistryService,
  ],
})
export class OperationsModule {}
