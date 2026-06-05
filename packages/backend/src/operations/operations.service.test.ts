import { describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import {
  AgentCommandStatus,
  Capability,
  OperationKind,
  OperationStatus,
} from '@nyabase/common';
import { AgentCommandOutboxEntity } from '../entities/agent-command-outbox.entity.js';
import { OperationEntity } from '../entities/operation.entity.js';
import { OperationStepEntity } from '../entities/operation-step.entity.js';
import { OperationsService } from './operations.service.js';
import { OperationOrchestratorService } from './operation-orchestrator.service.js';

async function makeDataSource() {
  const dataSource = new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
    synchronize: true,
    entities: [OperationEntity, OperationStepEntity, AgentCommandOutboxEntity],
  });
  await dataSource.initialize();
  return dataSource;
}

function makeService(dataSource: DataSource, capabilities: Capability[] = []) {
  void capabilities;
  return new OperationsService(
    dataSource,
    dataSource.getRepository(OperationEntity),
    dataSource.getRepository(OperationStepEntity),
    dataSource.getRepository(AgentCommandOutboxEntity),
    {} as OperationOrchestratorService,
  );
}

describe('OperationsService operation read authorization', () => {
  it('redacts sensitive payload keys for operation owner reads', async () => {
    const dataSource = await makeDataSource();
    try {
      await dataSource.getRepository(OperationEntity).save({
        id: 'op-a',
        idempotencyKey: 'op-a-key',
        kind: OperationKind.RemoteFsApply,
        resourceType: 'container',
        resourceId: 'container-a',
        serverId: 'server-a',
        requestedBy: 'owner-a',
        status: OperationStatus.Queued,
        request: { public: 'ok', secret: 'ceph-secret' },
        result: { token: 'runtime-token' },
        lastError: null,
        attempts: 0,
        startedAt: null,
        completedAt: null,
      });
      await dataSource.getRepository(AgentCommandOutboxEntity).save({
        id: 'cmd-a',
        operationId: 'op-a',
        operationStepId: null,
        serverId: 'server-a',
        resourceKey: 'container:container-a',
        commandKind: 'remote_fs.apply',
        idempotencyKey: 'cmd-a-key',
        desiredGeneration: null,
        payload: { params: { secret: 'ceph-secret' }, publicKeys: ['ssh-ed25519 AAAA'] },
        status: AgentCommandStatus.Pending,
        attempts: 0,
        lastError: null,
        nextAttemptAt: null,
        leaseHolderId: null,
        leaseExpiresAt: null,
        sentAt: null,
        completedAt: null,
      });

      const view = await makeService(dataSource).getOperationForUser('owner-a', 'op-a');

      expect(view.request).toEqual({ public: 'ok', secret: '[redacted]' });
      expect(view.result).toEqual({ token: '[redacted]' });
      expect(view.commands[0].payload).toEqual({
        params: { secret: '[redacted]' },
        publicKeys: '[redacted]',
      });
    } finally {
      await dataSource.destroy();
    }
  });

  it('does not let admin capabilities read other users operations through the user plane', async () => {
    const dataSource = await makeDataSource();
    try {
      await dataSource.getRepository(OperationEntity).save({
        id: 'op-container',
        idempotencyKey: 'op-container-key',
        kind: OperationKind.ContainerStart,
        resourceType: 'container',
        resourceId: 'container-a',
        serverId: 'server-a',
        requestedBy: 'other-user',
        status: OperationStatus.Queued,
        request: { action: 'start' },
        result: null,
        lastError: null,
        attempts: 0,
        startedAt: null,
        completedAt: null,
      });

      await expect(
        makeService(dataSource, [Capability.ManageContainersAny]).getOperationForUser('admin-a', 'op-container'),
      ).rejects.toThrow();
    } finally {
      await dataSource.destroy();
    }
  });

  it('allows the admin operation plane to read container operations', async () => {
    const dataSource = await makeDataSource();
    try {
      await dataSource.getRepository(OperationEntity).save({
        id: 'op-container',
        idempotencyKey: 'op-container-key',
        kind: OperationKind.ContainerStart,
        resourceType: 'container',
        resourceId: 'container-a',
        serverId: 'server-a',
        requestedBy: 'other-user',
        status: OperationStatus.Queued,
        request: { action: 'start' },
        result: null,
        lastError: null,
        attempts: 0,
        startedAt: null,
        completedAt: null,
      });

      const view = await makeService(dataSource, [Capability.ManageContainersAny]).getOperationForAdmin('op-container');

      expect(view.id).toBe('op-container');
      expect(view.requestedBy).toBe('other-user');
    } finally {
      await dataSource.destroy();
    }
  });
});
