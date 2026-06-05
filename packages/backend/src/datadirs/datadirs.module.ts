import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataDirsService } from './datadirs.service.js';
import { DataDirsController } from './datadirs.controller.js';
import { AdminDataDirsController } from './admin-datadirs.controller.js';
import { DataDirReconcilerService } from './data-dir-reconciler.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { AccessModule } from '../access/access.module.js';
import { ServersModule } from '../servers/servers.module.js';
import { UsersModule } from '../users/users.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { OperationsModule } from '../operations/operations.module.js';
import { DataDiskEntity } from '../entities/data-disk.entity.js';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { DataDirectoryEntity } from '../entities/data-directory.entity.js';
import { DataDirRuntimeObservationEntity } from '../entities/data-dir-runtime-observation.entity.js';
import { ContainerRuntimeObservationEntity } from '../entities/container-runtime-observation.entity.js';
import { ContainerMountEntity } from '../entities/container-mount.entity.js';
import { RuntimeContainerEntity } from '../entities/runtime-container.entity.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      DataDirectoryEntity,
      DataDiskEntity,
      RemoteFsMountEntity,
      RemoteFsServerAssignmentEntity,
      ContainerMountEntity,
      ContainerRuntimeObservationEntity,
      RuntimeContainerEntity,
      DataDirRuntimeObservationEntity,
    ]),
    AuthModule,
    AccessModule,
    ServersModule,
    UsersModule,
    AuditModule,
    OperationsModule,
  ],
  providers: [DataDirsService, DataDirReconcilerService],
  controllers: [DataDirsController, AdminDataDirsController],
  exports: [DataDirsService, DataDirReconcilerService],
})
export class DataDirsModule {}
