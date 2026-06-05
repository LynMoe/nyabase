import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, LessThanOrEqual, Repository } from 'typeorm';
import {
  AgentCommandKind,
  AgentCommandStatus,
  HookStatus,
  OperationKind,
  OperationStatus,
  type AgentCommandEnvelope,
} from '@nyabase/common';
import { AgentCommandOutboxEntity } from '../entities/agent-command-outbox.entity.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { OperationEntity } from '../entities/operation.entity.js';
import { OperationStepEntity } from '../entities/operation-step.entity.js';
import { ReconcileTaskEntity } from '../entities/reconcile-task.entity.js';
import { AgentGateway } from '../gateway/agent-gateway.js';
import { runSerializedTransaction } from '../database/serialized-transaction.js';
import { classifyRetry, errorMessage } from './operation-retry-policy.js';
import { OperationOrchestratorService } from './operation-orchestrator.service.js';
import { ResourceLockService, type AcquiredResourceLock } from './resource-lock.service.js';

const WORKER_INTERVAL_MS = 1_000;
const AGENT_COMMAND_ACK_TIMEOUT_MS = 60_000;
const COMMAND_LEASE_MS = AGENT_COMMAND_ACK_TIMEOUT_MS + 15_000;
const RESOURCE_LOCK_MS = AGENT_COMMAND_ACK_TIMEOUT_MS + 15_000;
const AGENT_COMMAND_KINDS = new Set<string>(Object.values(AgentCommandKind));
const DUE_COMMAND_STATUSES = [
  AgentCommandStatus.Pending,
  AgentCommandStatus.WaitingAgent,
  AgentCommandStatus.Retrying,
];
const TERMINAL_COMMAND_STATUSES = [
  AgentCommandStatus.Succeeded,
  AgentCommandStatus.Failed,
  AgentCommandStatus.Cancelled,
];
const TERMINAL_OPERATION_STATUSES = [
  OperationStatus.Succeeded,
  OperationStatus.Failed,
  OperationStatus.Cancelled,
];
const NON_TERMINAL_OPERATION_STATUSES = Object.values(OperationStatus)
  .filter((status) => !TERMINAL_OPERATION_STATUSES.includes(status));
const LEASE_RECOVERABLE_OPERATION_STATUSES = [
  OperationStatus.Queued,
  OperationStatus.WaitingAgent,
  OperationStatus.Running,
];
const REPAIR_BATCH_LIMIT = 100;

@Injectable()
export class AgentCommandOutboxWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentCommandOutboxWorkerService.name);
  private readonly workerId = `outbox-${process.pid}-${Math.random().toString(36).slice(2)}`;
  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = false;
  private readonly inFlightCommandIds = new Set<string>();
  private readonly inFlightResourceKeys = new Set<string>();

  constructor(
    private dataSource: DataSource,
    private agentGateway: AgentGateway,
    private orchestrator: OperationOrchestratorService,
    private resourceLocks: ResourceLockService,
    @InjectRepository(AgentCommandOutboxEntity)
    private outboxRepo: Repository<AgentCommandOutboxEntity>,
  ) {}

  onModuleInit(): void {
    void this.processBatch(1).catch((error) => {
      this.logger.warn(`outbox startup scan failed: ${errorMessage(error)}`);
    });
    this.timer = setInterval(() => {
      void this.processBatch(1).catch((error) => {
        this.logger.warn(`outbox interval failed: ${errorMessage(error)}`);
      });
    }, WORKER_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async processBatch(limit = 1): Promise<number> {
    if (this.processing) return 0;
    this.processing = true;
    try {
      await this.repairTerminalCommandOperationDrift();
      await this.recoverExpiredLeases();
      let processed = 0;
      for (let i = 0; i < limit; i += 1) {
        const didProcess = await this.processOne();
        if (!didProcess) break;
        processed += 1;
      }
      return processed;
    } finally {
      this.processing = false;
    }
  }

  async processOne(): Promise<boolean> {
    const candidate = await this.findNextDueCommand();
    if (!candidate) return false;

    const leased = await this.leaseCommand(candidate.id);
    if (!leased) return false;

    const lock = await this.resourceLocks.acquire(
      leased.resourceKey,
      `${this.workerId}:${leased.id}`,
      RESOURCE_LOCK_MS,
    );
    if (!lock) {
      await this.releaseForRetry(
        leased,
        'Resource is locked',
        new Date(Date.now() + 1_000),
        AgentCommandStatus.Retrying,
        OperationStatus.Retrying,
        HookStatus.Retrying,
      );
      return true;
    }

    try {
      if (!this.agentGateway.isOnline(leased.serverId)) {
        try {
          await this.releaseForRetry(
            leased,
            'Agent offline',
            new Date(Date.now() + 2_000),
            AgentCommandStatus.WaitingAgent,
            OperationStatus.WaitingAgent,
            HookStatus.WaitingAgent,
          );
        } finally {
          await this.resourceLocks.release(lock);
        }
        return true;
      }
      const envelope = this.toEnvelope(leased);
      this.inFlightCommandIds.add(leased.id);
      this.inFlightResourceKeys.add(leased.resourceKey);
      await this.orchestrator.markCommandSent(leased);
      const delivery = this.agentGateway.sendCommandEnvelope(
        leased.serverId,
        envelope,
      );
      void this.completeDelivery(leased, delivery, lock).catch((error) => {
        this.logger.warn(
          `outbox delivery completion failed for command ${leased.id}: ${errorMessage(error)}`,
        );
      });
      return true;
    } catch (error) {
      this.inFlightCommandIds.delete(leased.id);
      this.inFlightResourceKeys.delete(leased.resourceKey);
      try {
        await this.handleDeliveryFailure(leased, error);
      } finally {
        await this.resourceLocks.release(lock);
      }
    }
    return true;
  }

  async recoverExpiredLeases(now = new Date()): Promise<number> {
    await this.resourceLocks.recoverExpired(now);
    const expired = await this.outboxRepo.find({
      where: {
        status: In([AgentCommandStatus.Sent, AgentCommandStatus.Running]),
        leaseExpiresAt: LessThanOrEqual(now),
      },
    });
    const recoverable = expired.filter((command) => !this.inFlightCommandIds.has(command.id));
    if (recoverable.length === 0) return 0;
    let recovered = 0;
    await runSerializedTransaction(this.dataSource, async (manager) => {
      for (const candidate of recoverable) {
        const command = await manager.findOneBy(AgentCommandOutboxEntity, {
          id: candidate.id,
        });
        if (!command || this.inFlightCommandIds.has(command.id)) continue;
        if (![AgentCommandStatus.Sent, AgentCommandStatus.Running].includes(command.status)) {
          continue;
        }
        if (!command.leaseExpiresAt || command.leaseExpiresAt > now) continue;

        command.status = AgentCommandStatus.Retrying;
        command.leaseHolderId = null;
        command.leaseExpiresAt = null;
        command.nextAttemptAt = now;
        command.lastError = 'Command lease expired before terminal acknowledgement';
        await manager.save(AgentCommandOutboxEntity, command);
        await manager.update(
          OperationEntity,
          {
            id: command.operationId,
            status: In(LEASE_RECOVERABLE_OPERATION_STATUSES),
          },
          {
            status: OperationStatus.Retrying,
            lastError: command.lastError,
          },
        );
        recovered += 1;
      }
    });
    return recovered;
  }

  async repairTerminalCommandOperationDrift(
    now = new Date(),
    limit = REPAIR_BATCH_LIMIT,
  ): Promise<number> {
    const candidates = await this.outboxRepo
      .createQueryBuilder('command')
      .innerJoin(OperationEntity, 'operation', 'operation.id = command.operationId')
      .where('command.status IN (:...terminalCommandStatuses)', {
        terminalCommandStatuses: TERMINAL_COMMAND_STATUSES,
      })
      .andWhere('operation.status IN (:...nonTerminalOperationStatuses)', {
        nonTerminalOperationStatuses: NON_TERMINAL_OPERATION_STATUSES,
      })
      .orderBy('command.completedAt', 'ASC')
      .addOrderBy('command.updatedAt', 'ASC')
      .addOrderBy('command.id', 'ASC')
      .take(limit)
      .getMany();

    if (candidates.length === 0) return 0;

    let repaired = 0;
    await runSerializedTransaction(this.dataSource, async (manager) => {
      for (const candidate of candidates) {
        const command = await manager.findOneBy(AgentCommandOutboxEntity, {
          id: candidate.id,
        });
        if (!command || !TERMINAL_COMMAND_STATUSES.includes(command.status)) continue;
        const operation = await manager.findOneBy(OperationEntity, {
          id: command.operationId,
        });
        if (!operation || TERMINAL_OPERATION_STATUSES.includes(operation.status)) continue;
        operation.status = this.operationStatusForTerminalCommand(command.status);
        operation.lastError = command.status === AgentCommandStatus.Succeeded
          ? null
          : command.lastError;
        operation.completedAt = command.completedAt ?? now;
        await this.repairDomainSuccess(manager, operation, command);
        await manager.save(OperationEntity, operation);
        repaired += 1;
      }
    });

    if (repaired > 0) {
      this.logger.warn(`repaired ${repaired} terminal outbox/operation status drift row(s)`);
    }
    return repaired;
  }


  private async repairDomainSuccess(
    manager: import('typeorm').EntityManager,
    operation: OperationEntity,
    command: AgentCommandOutboxEntity,
  ): Promise<void> {
    if (command.status !== AgentCommandStatus.Succeeded) return;
    await this.orchestrator.applyOperationTerminalRepair(manager, operation, command);
  }

  private async findNextDueCommand(): Promise<AgentCommandOutboxEntity | null> {
    const now = new Date();
    const query = this.outboxRepo
      .createQueryBuilder('command')
      .where('command.status IN (:...statuses)', {
        statuses: DUE_COMMAND_STATUSES,
      })
      .andWhere('(command.nextAttemptAt IS NULL OR command.nextAttemptAt <= :now)', { now })
      .orderBy('command.createdAt', 'ASC')
      .addOrderBy('command.id', 'ASC');

    const lockedResourceKeys = Array.from(this.inFlightResourceKeys);
    if (lockedResourceKeys.length > 0) {
      query.andWhere('command.resourceKey NOT IN (:...lockedResourceKeys)', {
        lockedResourceKeys,
      });
    }

    return query.getOne();
  }

  private async leaseCommand(id: string): Promise<AgentCommandOutboxEntity | null> {
    const leaseExpiresAt = new Date(Date.now() + COMMAND_LEASE_MS);
    return runSerializedTransaction(this.dataSource, async (manager) => {
      const command = await manager.findOne(AgentCommandOutboxEntity, { where: { id } });
      if (!command) return null;
      if (!DUE_COMMAND_STATUSES.includes(command.status)) return null;
      const now = new Date();
      if (command.nextAttemptAt && command.nextAttemptAt > now) return null;

      command.status = AgentCommandStatus.Running;
      command.leaseHolderId = this.workerId;
      command.leaseExpiresAt = leaseExpiresAt;
      await manager.save(command);
      return command;
    });
  }

  private async completeDelivery(
    command: AgentCommandOutboxEntity,
    delivery: Promise<unknown>,
    lock: AcquiredResourceLock,
  ): Promise<void> {
    try {
      const result = await delivery;
      await this.orchestrator.markCommandSucceeded(command, result);
    } catch (error) {
      await this.handleDeliveryFailure(command, error);
    } finally {
      this.inFlightCommandIds.delete(command.id);
      this.inFlightResourceKeys.delete(command.resourceKey);
      await this.resourceLocks.release(lock);
    }
  }

  private async handleDeliveryFailure(
    command: AgentCommandOutboxEntity,
    error: unknown,
  ): Promise<void> {
    const decision = classifyRetry(error, command.attempts + 1);
    if (decision.retry && decision.nextAttemptAt) {
      const waitingAgent = errorMessage(error).toLowerCase().includes('offline');
      await this.releaseForRetry(
        command,
        error,
        decision.nextAttemptAt,
        waitingAgent ? AgentCommandStatus.WaitingAgent : AgentCommandStatus.Retrying,
        waitingAgent ? OperationStatus.WaitingAgent : OperationStatus.Retrying,
        waitingAgent ? HookStatus.WaitingAgent : HookStatus.Retrying,
      );
      return;
    }

    await this.orchestrator.markCommandFailed(command, error);
  }

  private async releaseForRetry(
    command: AgentCommandOutboxEntity,
    error: unknown,
    nextAttemptAt: Date,
    commandStatus: AgentCommandStatus,
    operationStatus: OperationStatus,
    hookStatus: HookStatus,
  ): Promise<void> {
    const lastError = errorMessage(error);
    await runSerializedTransaction(this.dataSource, async (manager) => {
      const currentCommand = await manager.findOneBy(AgentCommandOutboxEntity, {
        id: command.id,
      });
      if (!currentCommand || TERMINAL_COMMAND_STATUSES.includes(currentCommand.status)) {
        return;
      }
      await manager.update(AgentCommandOutboxEntity, command.id, {
        status: commandStatus,
        lastError,
        nextAttemptAt,
        leaseHolderId: null,
        leaseExpiresAt: null,
      });
      await manager.update(OperationEntity, command.operationId, {
        status: operationStatus,
        lastError,
      });
      if (command.operationStepId) {
        await manager.update(OperationStepEntity, command.operationStepId, {
          status: hookStatus,
          lastError,
        });
      }
      await manager.update(ReconcileTaskEntity, { operationId: command.operationId }, {
        status: hookStatus,
        lastError,
        nextAttemptAt,
      });
    });
  }

  private toEnvelope(command: AgentCommandOutboxEntity): AgentCommandEnvelope {
    const payload = this.requiredPayload(command);
    const envelope: AgentCommandEnvelope = {
      operationId: command.operationId,
      commandId: command.id,
      commandKind: this.agentCommandKind(command),
      idempotencyKey: command.idempotencyKey,
      resourceKey: command.resourceKey,
      desiredGeneration: command.desiredGeneration,
      payload,
    };
    return envelope;
  }

  private agentCommandKind(command: AgentCommandOutboxEntity): AgentCommandKind {
    if (AGENT_COMMAND_KINDS.has(command.commandKind)) {
      return command.commandKind as AgentCommandKind;
    }
    throw new Error(
      `Invalid outbox agent command kind "${command.commandKind}" for command ${command.id}`,
    );
  }

  private operationStatusForTerminalCommand(
    status: AgentCommandStatus,
  ): OperationStatus.Succeeded | OperationStatus.Failed | OperationStatus.Cancelled {
    switch (status) {
      case AgentCommandStatus.Succeeded:
        return OperationStatus.Succeeded;
      case AgentCommandStatus.Cancelled:
        return OperationStatus.Cancelled;
      case AgentCommandStatus.Failed:
        return OperationStatus.Failed;
      default:
        throw new Error(`Non-terminal command status cannot complete an operation: ${status}`);
    }
  }

  private requiredPayload(command: AgentCommandOutboxEntity): NonNullable<unknown> {
    if (command.payload === null || typeof command.payload === 'undefined') {
      throw new Error(`Missing outbox agent command payload for command ${command.id}`);
    }
    return command.payload as NonNullable<unknown>;
  }
}
