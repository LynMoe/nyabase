import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { AgentGateway } from './agent-gateway.js';
import { ConsoleGateway } from './console-gateway.js';
import { ExecSessionRegistry } from './exec-session-registry.js';
import { ServerEntity } from '../entities/server.entity.js';
import { MetricsModule } from '../metrics/metrics.module.js';
import { UsersModule } from '../users/users.module.js';
import { AgentTasksModule } from '../agent-tasks/agent-tasks.module.js';
import { DataDirsModule } from '../datadirs/datadirs.module.js';
import { ContainerLifecycleEntity } from '../entities/container-lifecycle.entity.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { SshModule } from '../ssh/ssh.module.js';
import { HttpProxyModule } from '../http-proxy/http-proxy.module.js';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { AgentTaskEntity } from '../entities/agent-task.entity.js';
import { ContainerMountEntity } from '../entities/container-mount.entity.js';
import { RuntimeDriftReconcilerService } from '../runtime/runtime-drift-reconciler.service.js';
import { UserEntity } from '../entities/user.entity.js';
import { FailStopService } from '../common/fail-stop.service.js';
import { ProxySnapshotNotifierModule } from '../proxy-snapshots/proxy-snapshot-notifier.module.js';
import { NetworkAddressClaimEntity } from '../entities/network-address-claim.entity.js';
import { ExecSessionAuthorizationService } from './exec-session-authorization.service.js';

// Explicitly imported by every module that injects AgentGateway /
// ConsoleGateway / ExecSessionRegistry. Was @Global previously; reverted so
// module boundaries stay legible and unit tests can mock dependencies cleanly.
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ServerEntity,
      ContainerLifecycleEntity,
      ContainerEntity,
      RemoteFsMountEntity,
      RemoteFsServerAssignmentEntity,
      AgentTaskEntity,
      ContainerMountEntity,
      UserEntity,
      NetworkAddressClaimEntity,
    ]),
    forwardRef(() => MetricsModule),
    // UsersModule pulls in GroupsModule which pulls in AgentGatewayModule
    // → cycle. forwardRef breaks it cleanly because Nest only needs the
    // reference when wiring providers, not at module evaluation time.
    forwardRef(() => UsersModule),
    AgentTasksModule,
    ProxySnapshotNotifierModule,
    forwardRef(() => DataDirsModule),
    forwardRef(() => SshModule),
    forwardRef(() => HttpProxyModule),
    JwtModule.registerAsync({
      inject: [NyabaseConfigService],
      useFactory: (config: NyabaseConfigService) => ({
        secret: config.get<string>('auth.jwtSecret'),
      }),
    }),
  ],
  providers: [
    AgentGateway,
    ConsoleGateway,
    ExecSessionRegistry,
    ExecSessionAuthorizationService,
    RuntimeDriftReconcilerService,
    FailStopService,
  ],
  exports: [
    AgentGateway,
    ConsoleGateway,
    ExecSessionRegistry,
    ExecSessionAuthorizationService,
  ],
})
export class AgentGatewayModule {}
