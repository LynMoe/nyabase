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
import { ContainerOperationService } from '../container-operation.service.js';
import { ContainerEntity } from '../../entities/container.entity.js';
import { ContainerLifecycleEntity } from '../../entities/container-lifecycle.entity.js';
import { ContainerDesiredSpecEntity } from '../../entities/container-desired-spec.entity.js';
import { OperationEntity } from '../../entities/operation.entity.js';
import { OperationStepEntity } from '../../entities/operation-step.entity.js';
import { AgentCommandOutboxEntity } from '../../entities/agent-command-outbox.entity.js';

async function makeDataSource() {
  const dataSource = new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
    synchronize: true,
    entities: [
      ContainerEntity,
      ContainerLifecycleEntity,
      ContainerDesiredSpecEntity,
      OperationEntity,
      OperationStepEntity,
      AgentCommandOutboxEntity,
    ],
  });
  await dataSource.initialize();
  return dataSource;
}

describe('ContainerOperationService V2', () => {
  it('creates operation, step, command, and marks lifecycle active operation atomically', async () => {
    const dataSource = await makeDataSource();
    try {
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
        cpuMillis: 1000,
        memBytes: 1024,
        diskBytes: 0,
        gpuMode: 'none',
        gpuIndices: [],
        mountsJson: [],
        sshEnabled: false,
        powerIntent: ContainerPowerIntent.Running,
      });
      const service = new ContainerOperationService(dataSource, dataSource.getRepository(OperationEntity));
      const ref = await service.enqueueExistingContainerAction({
        containerId: 'container-a',
        requestedBy: 'user-a',
        kind: OperationKind.ContainerStop,
        commandKind: AgentCommandKind.RuntimeContainerPower,
        request: { action: 'stop' },
        payload: { containerId: 'container-a', action: 'stop' },
        phase: ContainerPhase.Updating,
      });

      expect(ref.status).toBe(OperationStatus.Queued);
      const operation = await dataSource.getRepository(OperationEntity).findOneByOrFail({ id: ref.operationId });
      expect(operation).toMatchObject({ kind: OperationKind.ContainerStop, resourceId: 'container-a' });
      const command = await dataSource.getRepository(AgentCommandOutboxEntity).findOneByOrFail({ operationId: ref.operationId });
      expect(command).toMatchObject({ commandKind: AgentCommandKind.RuntimeContainerPower, status: AgentCommandStatus.Pending });
      const lifecycle = await dataSource.getRepository(ContainerLifecycleEntity).findOneByOrFail({ containerId: 'container-a' });
      expect(lifecycle).toMatchObject({ phase: ContainerPhase.Updating, activeOperationId: ref.operationId });
    } finally {
      await dataSource.destroy();
    }
  });
});
