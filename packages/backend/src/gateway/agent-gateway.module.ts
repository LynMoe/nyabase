import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AgentGateway } from './agent-gateway.js';
import { ConsoleGateway } from './console-gateway.js';
import { ExecSessionRegistry } from './exec-session-registry.js';
import { ServerEntity } from '../entities/server.entity.js';
import { MetricsModule } from '../metrics/metrics.module.js';
import { UsersModule } from '../users/users.module.js';
import { OperationsModule } from '../operations/operations.module.js';
import { DataDirsModule } from '../datadirs/datadirs.module.js';
import { RuntimeOrphanEntity } from '../entities/runtime-orphan.entity.js';
import { ContainerLifecycleEntity } from '../entities/container-lifecycle.entity.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { RuntimeOrphanService } from '../runtime/runtime-orphan.service.js';

// Explicitly imported by every module that injects AgentGateway /
// ConsoleGateway / ExecSessionRegistry. Was @Global previously; reverted so
// module boundaries stay legible and unit tests can mock dependencies cleanly.
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ServerEntity,
      RuntimeOrphanEntity,
      ContainerLifecycleEntity,
      ContainerEntity,
    ]),
    forwardRef(() => MetricsModule),
    // UsersModule pulls in GroupsModule which pulls in AgentGatewayModule
    // → cycle. forwardRef breaks it cleanly because Nest only needs the
    // reference when wiring providers, not at module evaluation time.
    forwardRef(() => UsersModule),
    forwardRef(() => OperationsModule),
    forwardRef(() => DataDirsModule),
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
    RuntimeOrphanService,
  ],
  exports: [AgentGateway, ConsoleGateway, ExecSessionRegistry],
})
export class AgentGatewayModule {}
