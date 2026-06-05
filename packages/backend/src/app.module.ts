import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database/database.module.js';
import { AuthModule } from './auth/auth.module.js';
import { UsersModule } from './users/users.module.js';
import { ServersModule } from './servers/servers.module.js';
import { ImagesModule } from './images/images.module.js';
import { GroupsModule } from './groups/groups.module.js';
import { AgentGatewayModule } from './gateway/agent-gateway.module.js';
import { ContainersModule } from './containers/containers.module.js';
import { MetricsModule } from './metrics/metrics.module.js';
import { DataDirsModule } from './datadirs/datadirs.module.js';
import { AuditModule } from './audit/audit.module.js';
import { RemoteFsMountsModule } from './remote-fs/remote-fs-mounts.module.js';
import { MountSourcesModule } from './mount-sources/mount-sources.module.js';
import { OperationsModule } from './operations/operations.module.js';
import { AppService } from './app.service.js';
import appConfig from './config/app.config.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig],
      envFilePath: ['.env.local', '.env'],
    }),
    DatabaseModule,
    AuthModule,
    UsersModule,
    ServersModule,
    ImagesModule,
    GroupsModule,
    AgentGatewayModule,
    ContainersModule,
    MetricsModule,
    DataDirsModule,
    AuditModule,
    RemoteFsMountsModule,
    MountSourcesModule,
    OperationsModule,
  ],
  providers: [AppService],
})
export class AppModule {}
