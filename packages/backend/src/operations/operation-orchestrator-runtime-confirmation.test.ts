import { describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import {
  AgentCommandKind,
  AgentCommandStatus,
  ContainerPhase,
  ContainerPowerIntent,
  OperationKind,
  OperationStatus,
} from '@nyabase/common';
import { OperationOrchestratorService } from './operation-orchestrator.service.js';
import { AgentCommandOutboxEntity } from '../entities/agent-command-outbox.entity.js';
import { ContainerDesiredSpecEntity } from '../entities/container-desired-spec.entity.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { ContainerLifecycleEntity } from '../entities/container-lifecycle.entity.js';
import { ContainerMountEntity } from '../entities/container-mount.entity.js';
import { GpuAllocationEntity } from '../entities/gpu-allocation.entity.js';
import { OperationEntity } from '../entities/operation.entity.js';
import { OperationStepEntity } from '../entities/operation-step.entity.js';
import { QuotaDesiredEntity } from '../entities/quota-desired.entity.js';
import { ReconcileTaskEntity } from '../entities/reconcile-task.entity.js';

async function makeDataSource() {
  const dataSource = new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
    synchronize: true,
    entities: [
      AgentCommandOutboxEntity,
      ContainerDesiredSpecEntity,
      ContainerEntity,
      ContainerLifecycleEntity,
      ContainerMountEntity,
      GpuAllocationEntity,
      OperationEntity,
      OperationStepEntity,
      QuotaDesiredEntity,
      ReconcileTaskEntity,
    ],
  });
  await dataSource.initialize();
  return dataSource;
}

describe('OperationOrchestratorService runtime confirmation', () => {
  it('writes a confirmation lock after successful runtime operations and skips delete', async () => {
    const dataSource = await makeDataSource();
    try {
      await seedContainer(dataSource);
      const service = new OperationOrchestratorService(
        dataSource,
        dataSource.getRepository(OperationEntity),
        dataSource.getRepository(OperationStepEntity),
        dataSource.getRepository(AgentCommandOutboxEntity),
        dataSource.getRepository(ReconcileTaskEntity),
      );

      await succeed(service, dataSource, OperationKind.ContainerCreate, AgentCommandKind.RuntimeContainerCreate, {
        runtimeId: 'runtime-a',
      });
      let lifecycle = await dataSource.getRepository(ContainerLifecycleEntity).findOneByOrFail({ containerId: 'container-a' });
      expect(lifecycle.runtimeConfirmation).toMatchObject({
        kind: OperationKind.ContainerCreate,
        expectedRuntimeId: 'runtime-a',
      });

      await succeed(service, dataSource, OperationKind.ContainerStop, AgentCommandKind.RuntimeContainerPower, {});
      lifecycle = await dataSource.getRepository(ContainerLifecycleEntity).findOneByOrFail({ containerId: 'container-a' });
      expect(lifecycle.runtimeConfirmation).toMatchObject({
        kind: OperationKind.ContainerStop,
        expectedPowerIntent: ContainerPowerIntent.Stopped,
      });

      await dataSource.getRepository(ContainerDesiredSpecEntity).update({ containerId: 'container-a' }, { generation: 3 });
      await succeed(service, dataSource, OperationKind.ContainerUpdateMounts, AgentCommandKind.RuntimeContainerMountsApply, {});
      lifecycle = await dataSource.getRepository(ContainerLifecycleEntity).findOneByOrFail({ containerId: 'container-a' });
      expect(lifecycle.runtimeConfirmation).toMatchObject({
        kind: OperationKind.ContainerUpdateMounts,
        expectedGeneration: 3,
      });

      await succeed(service, dataSource, OperationKind.ContainerDelete, AgentCommandKind.RuntimeContainerDelete, {});
      lifecycle = await dataSource.getRepository(ContainerLifecycleEntity).findOneByOrFail({ containerId: 'container-a' });
      expect(lifecycle.runtimeConfirmation).toBeNull();
    } finally {
      await dataSource.destroy();
    }
  });
});

async function seedContainer(dataSource: DataSource): Promise<void> {
  await dataSource.getRepository(ContainerEntity).save({
    id: 'container-a',
    serverId: 'server-a',
    ownerId: 'user-a',
    name: 'work',
    imageId: 'image-a',
    createdBy: 'user-a',
    deletedAt: null,
  });
  await dataSource.getRepository(ContainerLifecycleEntity).save({
    containerId: 'container-a',
    phase: ContainerPhase.Active,
    boundRuntimeId: 'runtime-a',
    activeOperationId: null,
    runtimeConfirmation: null,
    lastTransitionAt: new Date(),
    failureReason: null,
    failureCode: null,
  });
  await dataSource.getRepository(ContainerDesiredSpecEntity).save({
    id: 'spec-a',
    containerId: 'container-a',
    generation: 1,
    imageRef: 'alpine:latest',
    imageDefaultUid: 0,
    imageRuntimeOverrides: { uid: 0, entrypoint: null, cmd: null, init: false },
    cpuMillis: 1000,
    memBytes: 1024,
    diskBytes: 0,
    gpuMode: 'none',
    gpuIndices: [],
    mountsJson: [],
    sshEnabled: false,
    powerIntent: ContainerPowerIntent.Running,
  });
}

async function succeed(
  service: OperationOrchestratorService,
  dataSource: DataSource,
  kind: OperationKind,
  commandKind: AgentCommandKind,
  result: unknown,
): Promise<void> {
  const id = `${kind}:${Date.now()}:${Math.random()}`;
  const operation = await dataSource.getRepository(OperationEntity).save({
    id,
    idempotencyKey: id,
    kind,
    resourceType: 'container',
    resourceId: 'container-a',
    serverId: 'server-a',
    requestedBy: 'user-a',
    status: OperationStatus.WaitingAgent,
    request: {},
    result: null,
    lastError: null,
    attempts: 0,
    startedAt: new Date(),
    completedAt: null,
  });
  const command = await dataSource.getRepository(AgentCommandOutboxEntity).save({
    id: `${id}:command`,
    operationId: operation.id,
    operationStepId: null,
    serverId: 'server-a',
    resourceKey: 'container:container-a',
    commandKind,
    idempotencyKey: `${id}:command`,
    desiredGeneration: null,
    payload: {},
    status: AgentCommandStatus.Sent,
    attempts: 1,
    lastError: null,
    nextAttemptAt: null,
    leaseHolderId: null,
    leaseExpiresAt: null,
    sentAt: new Date(),
    completedAt: null,
  });
  await service.markCommandSucceeded(command, result);
}
