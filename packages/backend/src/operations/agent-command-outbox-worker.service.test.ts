import { describe, expect, it, vi } from 'vitest';
import { DataSource } from 'typeorm';
import {
  AgentCommandKind,
  AgentCommandStatus,
  HookStatus,
  OperationKind,
  OperationStatus,
} from '@nyabase/common';
import { AgentCommandOutboxEntity } from '../entities/agent-command-outbox.entity.js';
import { OperationEntity } from '../entities/operation.entity.js';
import { OperationStepEntity } from '../entities/operation-step.entity.js';
import { ReconcileTaskEntity } from '../entities/reconcile-task.entity.js';
import { AgentCommandOutboxWorkerService } from './agent-command-outbox-worker.service.js';

async function makeDataSource() {
  const dataSource = new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
    synchronize: true,
    entities: [OperationEntity, OperationStepEntity, AgentCommandOutboxEntity, ReconcileTaskEntity],
  });
  await dataSource.initialize();
  return dataSource;
}

async function seedCommand(dataSource: DataSource) {
  await dataSource.getRepository(OperationEntity).save({
    id: 'operation-a',
    idempotencyKey: 'operation-a-key',
    kind: OperationKind.ContainerStart,
    resourceType: 'container',
    resourceId: 'container-a',
    serverId: 'server-a',
    requestedBy: 'user-a',
    status: OperationStatus.Queued,
    request: { action: 'start' },
    result: null,
    lastError: null,
    attempts: 0,
    startedAt: null,
    completedAt: null,
  });
  await dataSource.getRepository(OperationStepEntity).save({
    id: 'step-a',
    operationId: 'operation-a',
    stepKey: 'dispatch-runtime-command',
    sequence: 1,
    hook: null,
    status: HookStatus.Pending,
    desiredGeneration: null,
    commandId: 'command-a',
    attempts: 0,
    lastError: null,
    result: null,
    startedAt: null,
    completedAt: null,
  });
  await dataSource.getRepository(AgentCommandOutboxEntity).save({
    id: 'command-a',
    operationId: 'operation-a',
    operationStepId: 'step-a',
    serverId: 'server-a',
    resourceKey: 'container:container-a',
    commandKind: AgentCommandKind.RuntimeContainerPower,
    idempotencyKey: 'command-a-key',
    desiredGeneration: null,
    payload: { containerId: 'container-a', runtimeId: 'runtime-a', action: 'start' },
    status: AgentCommandStatus.Pending,
    attempts: 0,
    lastError: null,
    nextAttemptAt: new Date(Date.now() - 1000),
    leaseHolderId: null,
    leaseExpiresAt: null,
    sentAt: null,
    completedAt: null,
  });
}

function makeWorker(dataSource: DataSource, runtimeReady: boolean) {
  const agentGateway = {
    isOnline: vi.fn().mockReturnValue(true),
    stateCache: { isRuntimeReady: vi.fn().mockReturnValue(runtimeReady) },
    sendCommandEnvelope: vi.fn().mockResolvedValue({ ok: true }),
  };
  const orchestrator = {
    markCommandSent: vi.fn().mockResolvedValue(undefined),
    markCommandSucceeded: vi.fn().mockResolvedValue(undefined),
    applyOperationTerminalRepair: vi.fn().mockResolvedValue(undefined),
  };
  const lock = { id: 'lock-a' };
  const resourceLocks = {
    acquire: vi.fn().mockResolvedValue(lock),
    release: vi.fn().mockResolvedValue(undefined),
    recoverExpired: vi.fn().mockResolvedValue(undefined),
  };
  const worker = new AgentCommandOutboxWorkerService(
    dataSource,
    agentGateway as never,
    orchestrator as never,
    resourceLocks as never,
    dataSource.getRepository(AgentCommandOutboxEntity),
  );
  return { worker, agentGateway, orchestrator };
}

describe('AgentCommandOutboxWorkerService runtime readiness gating', () => {
  it('does not deliver runtime commands while the server has no full state report', async () => {
    const dataSource = await makeDataSource();
    try {
      await seedCommand(dataSource);
      const { worker, agentGateway, orchestrator } = makeWorker(dataSource, false);

      await expect(worker.processBatch(1)).resolves.toBe(1);

      expect(agentGateway.sendCommandEnvelope).not.toHaveBeenCalled();
      expect(orchestrator.markCommandSent).not.toHaveBeenCalled();
      await expect(dataSource.getRepository(AgentCommandOutboxEntity).findOneByOrFail({ id: 'command-a' }))
        .resolves
        .toMatchObject({
          status: AgentCommandStatus.WaitingAgent,
          lastError: 'Agent runtime state is not ready',
        });
      await expect(dataSource.getRepository(OperationEntity).findOneByOrFail({ id: 'operation-a' }))
        .resolves
        .toMatchObject({
          status: OperationStatus.WaitingAgent,
          lastError: 'Agent runtime state is not ready',
        });
    } finally {
      await dataSource.destroy();
    }
  });

  it('delivers pending runtime commands after runtime readiness is true', async () => {
    const dataSource = await makeDataSource();
    try {
      await seedCommand(dataSource);
      const { worker, agentGateway, orchestrator } = makeWorker(dataSource, true);

      await expect(worker.processBatch(1)).resolves.toBe(1);

      expect(orchestrator.markCommandSent).toHaveBeenCalledWith(expect.objectContaining({ id: 'command-a' }));
      expect(agentGateway.sendCommandEnvelope).toHaveBeenCalledWith('server-a', expect.objectContaining({
        operationId: 'operation-a',
        commandId: 'command-a',
        commandKind: AgentCommandKind.RuntimeContainerPower,
      }));
    } finally {
      await dataSource.destroy();
    }
  });
});

