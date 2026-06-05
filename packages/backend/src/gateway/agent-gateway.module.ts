import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AgentGateway } from './agent-gateway.js';
import { ConsoleGateway } from './console-gateway.js';
import { ContainerRuntimeObservationWriter } from './container-runtime-observation-writer.service.js';
import { ExecSessionRegistry } from './exec-session-registry.js';
import { DataDirRuntimeObservationEntity } from '../entities/data-dir-runtime-observation.entity.js';
import { DataDiskRuntimeObservationEntity } from '../entities/data-disk-runtime-observation.entity.js';
import { QuotaRuntimeObservationEntity } from '../entities/quota-runtime-observation.entity.js';
import { RemoteFsRuntimeObservationEntity } from '../entities/remote-fs-runtime-observation.entity.js';
import { ServerEntity } from '../entities/server.entity.js';
import { ContainerRuntimeObservationEntity } from '../entities/container-runtime-observation.entity.js';
import { MetricsModule } from '../metrics/metrics.module.js';
import { UsersModule } from '../users/users.module.js';
import { OperationsModule } from '../operations/operations.module.js';
import { RuntimeOrphanEntity } from '../entities/runtime-orphan.entity.js';
import { RuntimeGpuInventoryEntity } from '../entities/runtime-gpu-inventory.entity.js';
import { RuntimeContainerStatEntity } from '../entities/runtime-container-stat.entity.js';
import { RuntimeContainerEntity } from '../entities/runtime-container.entity.js';
import { ContainerLifecycleEntity } from '../entities/container-lifecycle.entity.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { RuntimeOrphanService } from '../runtime/runtime-orphan.service.js';
import { RuntimeObservationService } from '../runtime/runtime-observation.service.js';
import { DockerDaemonRuntimeObservationEntity } from '../entities/docker-daemon-runtime-observation.entity.js';

// Explicitly imported by every module that injects AgentGateway /
// ConsoleGateway / ExecSessionRegistry. Was @Global previously; reverted so
// module boundaries stay legible and unit tests can mock dependencies cleanly.
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ServerEntity,
      ContainerRuntimeObservationEntity,
      DataDirRuntimeObservationEntity,
      RemoteFsRuntimeObservationEntity,
      DataDiskRuntimeObservationEntity,
      QuotaRuntimeObservationEntity,
      RuntimeOrphanEntity,
      RuntimeGpuInventoryEntity,
      RuntimeContainerStatEntity,
      RuntimeContainerEntity,
      ContainerLifecycleEntity,
      ContainerEntity,
      DockerDaemonRuntimeObservationEntity,
    ]),
    forwardRef(() => MetricsModule),
    // UsersModule pulls in GroupsModule which pulls in AgentGatewayModule
    // → cycle. forwardRef breaks it cleanly because Nest only needs the
    // reference when wiring providers, not at module evaluation time.
    forwardRef(() => UsersModule),
    forwardRef(() => OperationsModule),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('app.jwtSecret'),
      }),
    }),
  ],
  providers: [
    AgentGateway,
    ConsoleGateway,
    ExecSessionRegistry,
    ContainerRuntimeObservationWriter,
    RuntimeObservationService,
    RuntimeOrphanService,
  ],
  exports: [AgentGateway, ConsoleGateway, ExecSessionRegistry],
})
export class AgentGatewayModule {}
