import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RemoteFsMountsService } from './remote-fs-mounts.service.js';
import { RemoteFsMountsController } from './remote-fs-mounts.controller.js';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { RemoteFsRuntimeObservationEntity } from '../entities/remote-fs-runtime-observation.entity.js';
import { ContainerMountEntity } from '../entities/container-mount.entity.js';
import { DataDirectoryEntity } from '../entities/data-directory.entity.js';
import { MountSourceGrantEntity } from '../entities/mount-source-grant.entity.js';
import { AuthModule } from '../auth/auth.module.js';
import { AccessModule } from '../access/access.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { OperationsModule } from '../operations/operations.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      RemoteFsMountEntity,
      RemoteFsServerAssignmentEntity,
      RemoteFsRuntimeObservationEntity,
      ContainerMountEntity,
      DataDirectoryEntity,
      MountSourceGrantEntity,
    ]),
    AuthModule,
    AccessModule,
    AuditModule,
    OperationsModule,
  ],
  providers: [RemoteFsMountsService],
  controllers: [RemoteFsMountsController],
  exports: [RemoteFsMountsService],
})
export class RemoteFsMountsModule {}
