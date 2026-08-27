import { Module, forwardRef } from '@nestjs/common';
import { ServersService } from './servers.service.js';
import { ServersController } from './servers.controller.js';
import { AdminServersController } from './admin-servers.controller.js';
import { AuthModule } from '../auth/auth.module.js';
import { AccessModule } from '../access/access.module.js';
import { UsersModule } from '../users/users.module.js';
import { SshModule } from '../ssh/ssh.module.js';
import { ProxySnapshotNotifierModule } from '../proxy-snapshots/proxy-snapshot-notifier.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { StoragePoolsModule } from '../storage-pools/storage-pools.module.js';
import { VolumesModule } from '../volumes/volumes.module.js';
import { InfrastructureModule } from '../infrastructure/infrastructure.module.js';
import { RuntimeModule } from '../runtime/runtime.module.js';
import { AdminIncusClientCertificateController } from './admin-incus-client-certificate.controller.js';
import { IncusClientCertificateService } from './incus-client-certificate.service.js';

@Module({
  imports: [
    forwardRef(() => AuthModule),
    forwardRef(() => AccessModule),
    forwardRef(() => UsersModule),
    forwardRef(() => SshModule),
    ProxySnapshotNotifierModule,
    AuditModule,
    StoragePoolsModule,
    VolumesModule,
    InfrastructureModule,
    RuntimeModule,
  ],
  providers: [ServersService, IncusClientCertificateService],
  controllers: [
    ServersController,
    AdminServersController,
    AdminIncusClientCertificateController,
  ],
  exports: [ServersService],
})
export class ServersModule {}
