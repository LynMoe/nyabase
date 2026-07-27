import { Module, forwardRef } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AgentGateway } from './agent-gateway.js';
import { ConsoleGateway } from './console-gateway.js';
import { ExecSessionRegistry } from './exec-session-registry.js';
import { MetricsModule } from '../metrics/metrics.module.js';
import { AgentTasksModule } from '../agent-tasks/agent-tasks.module.js';
import { DataDirsModule } from '../datadirs/datadirs.module.js';
import { SshModule } from '../ssh/ssh.module.js';
import { HttpProxyModule } from '../http-proxy/http-proxy.module.js';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';
import { RuntimeDriftReconcilerService } from '../runtime/runtime-drift-reconciler.service.js';
import { ProxySnapshotNotifierModule } from '../proxy-snapshots/proxy-snapshot-notifier.module.js';
import { ExecSessionAuthorizationService } from './exec-session-authorization.service.js';
import { InfrastructureModule } from '../infrastructure/infrastructure.module.js';
import { ContainerControlRepository } from '../containers/container-control.repository.js';
import { StorageModule } from '../storage/storage.module.js';
import { StateCache } from './state-cache.js';

// Explicitly imported by every module that injects AgentGateway /
// ConsoleGateway / ExecSessionRegistry. Was @Global previously; reverted so
// module boundaries stay legible and unit tests can mock dependencies cleanly.
@Module({
  imports: [
    forwardRef(() => MetricsModule),
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
    InfrastructureModule,
    StorageModule,
  ],
  providers: [
    AgentGateway,
    ConsoleGateway,
    ExecSessionRegistry,
    ExecSessionAuthorizationService,
    RuntimeDriftReconcilerService,
    ContainerControlRepository,
    StateCache,
  ],
  exports: [
    AgentGateway,
    ConsoleGateway,
    ExecSessionRegistry,
    ExecSessionAuthorizationService,
    StateCache,
  ],
})
export class AgentGatewayModule {}
