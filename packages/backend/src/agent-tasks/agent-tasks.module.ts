import { Module } from '@nestjs/common';
import { RemoteFsSecretCryptoService } from '../remote-fs/remote-fs-secret-crypto.service.js';
import { AgentTaskDispatcherService } from './agent-task-dispatcher.service.js';
import { AgentTaskPayloadCodecService } from './agent-task-payload-codec.service.js';
import { AgentTaskResultService } from './agent-task-result.service.js';
import { AgentTasksService } from './agent-tasks.service.js';
import { ResourceKeyService } from './resource-key.service.js';
import { ProxySnapshotNotifierModule } from '../proxy-snapshots/proxy-snapshot-notifier.module.js';
import { AccessCacheEpochModule } from '../access/access-cache-epoch.module.js';
import { AgentTaskRetentionService } from './agent-task-retention.service.js';
import { WorkflowEnqueuePort } from './workflow-enqueue.port.js';
import { WorkflowRepository } from './workflow.repository.js';
import { WorkflowOutboxWorkerService } from './workflow-outbox-worker.service.js';
import { WorkflowFinalizerRegistry } from './workflow-finalizer.registry.js';
import { WorkflowDispatchService } from './workflow-dispatch.service.js';
import { WorkflowFinalizerWorkerService } from './workflow-finalizer-worker.service.js';
import { FailStopService } from '../common/fail-stop.service.js';
import { AgentSessionLockDatabase } from './agent-session-lock-database.js';

@Module({
  imports: [
    AccessCacheEpochModule,
    ProxySnapshotNotifierModule,
  ],
  providers: [
    AgentTasksService,
    AgentTaskDispatcherService,
    AgentTaskPayloadCodecService,
    AgentTaskResultService,
    AgentTaskRetentionService,
    RemoteFsSecretCryptoService,
    ResourceKeyService,
    WorkflowEnqueuePort,
    WorkflowRepository,
    WorkflowOutboxWorkerService,
    WorkflowFinalizerRegistry,
    WorkflowDispatchService,
    WorkflowFinalizerWorkerService,
    FailStopService,
    AgentSessionLockDatabase,
  ],
  exports: [
    AgentTasksService,
    AgentTaskDispatcherService,
    AgentTaskResultService,
    AgentTaskPayloadCodecService,
    ResourceKeyService,
    WorkflowEnqueuePort,
    WorkflowRepository,
    WorkflowFinalizerRegistry,
    WorkflowFinalizerWorkerService,
    FailStopService,
  ],
})
export class AgentTasksModule {}
