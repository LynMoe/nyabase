import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentTaskEntity } from '../entities/agent-task.entity.js';
import { ResourceLockEntity } from '../entities/resource-lock.entity.js';
import { RemoteFsSecretCryptoService } from '../remote-fs/remote-fs-secret-crypto.service.js';
import { AgentTaskDispatcherService } from './agent-task-dispatcher.service.js';
import { AgentTaskFinalizerService } from './agent-task-finalizer.service.js';
import { AgentTaskFinalizerWorkerService } from './agent-task-finalizer-worker.service.js';
import { AgentTaskPayloadCodecService } from './agent-task-payload-codec.service.js';
import { AgentTaskResultService } from './agent-task-result.service.js';
import { AgentTasksService } from './agent-tasks.service.js';
import { ResourceKeyService } from './resource-key.service.js';
import { ResourceLockService } from './resource-lock.service.js';
import { ProxySnapshotNotifierModule } from '../proxy-snapshots/proxy-snapshot-notifier.module.js';
import { AccessCacheEpochModule } from '../access/access-cache-epoch.module.js';
import { AgentTaskRetentionService } from './agent-task-retention.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([AgentTaskEntity, ResourceLockEntity]),
    AccessCacheEpochModule,
    ProxySnapshotNotifierModule,
  ],
  providers: [
    AgentTasksService,
    AgentTaskDispatcherService,
    AgentTaskFinalizerService,
    AgentTaskFinalizerWorkerService,
    AgentTaskPayloadCodecService,
    AgentTaskResultService,
    AgentTaskRetentionService,
    RemoteFsSecretCryptoService,
    ResourceKeyService,
    ResourceLockService,
  ],
  exports: [
    AgentTasksService,
    AgentTaskDispatcherService,
    AgentTaskFinalizerWorkerService,
    AgentTaskResultService,
    AgentTaskPayloadCodecService,
    ResourceKeyService,
    ResourceLockService,
  ],
})
export class AgentTasksModule {}
