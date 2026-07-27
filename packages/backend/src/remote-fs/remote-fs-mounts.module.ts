import { Module } from '@nestjs/common';
import { RemoteFsMountsService } from './remote-fs-mounts.service.js';
import { RemoteFsMountsController } from './remote-fs-mounts.controller.js';
import { AuthModule } from '../auth/auth.module.js';
import { AccessModule } from '../access/access.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { AgentTasksModule } from '../agent-tasks/agent-tasks.module.js';
import { AgentGatewayModule } from '../gateway/agent-gateway.module.js';
import { RemoteFsSecretCryptoService } from './remote-fs-secret-crypto.service.js';
import { MountSourcesModule } from '../mount-sources/mount-sources.module.js';
import { ProxySnapshotNotifierModule } from '../proxy-snapshots/proxy-snapshot-notifier.module.js';
import { StorageModule } from '../storage/storage.module.js';
import {
  RemoteFsWorkflowFinalizerService,
} from './remote-fs-workflow-finalizer.service.js';

@Module({
  imports: [
    StorageModule,
    AuthModule,
    AccessModule,
    AuditModule,
    AgentTasksModule,
    AgentGatewayModule,
    MountSourcesModule,
    ProxySnapshotNotifierModule,
  ],
  providers: [
    RemoteFsMountsService,
    RemoteFsSecretCryptoService,
    RemoteFsWorkflowFinalizerService,
  ],
  controllers: [RemoteFsMountsController],
  exports: [RemoteFsMountsService],
})
export class RemoteFsMountsModule {}
