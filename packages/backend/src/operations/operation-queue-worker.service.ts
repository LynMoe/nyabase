import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import {
  AgentCommandKind,
  OperationStatus,
  type AgentCommandEnvelope,
} from '@nyabase/common';
import { CommandHookRegistry } from '../command-hooks/command-hook-registry.service.js';
import { AgentGateway } from '../gateway/agent-gateway.js';
import { OperationEntity } from '../entities/operation.entity.js';
import { runSerializedTransaction } from '../database/serialized-transaction.js';
import { OperationDomainApplierService } from './operation-domain-applier.service.js';
import { OperationsService } from './operations.service.js';
import { ResourceLockService } from './resource-lock.service.js';
import type {
  CommandHookPlanEntry,
  CommandHookResultEntry,
} from './operation-types.js';

const WORKER_INTERVAL_MS = 500;
const COMMAND_ACK_TIMEOUT_MS = 60_000;
const AGENT_COMMAND_KINDS = new Set<string>(Object.values(AgentCommandKind));

@Injectable()
export class OperationQueueWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OperationQueueWorkerService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = false;

  constructor(
    private dataSource: DataSource,
    private agentGateway: AgentGateway,
    private operations: OperationsService,
    private hooks: CommandHookRegistry,
    private domainApplier: OperationDomainApplierService,
    private resourceLocks: ResourceLockService,
    @InjectRepository(OperationEntity)
    private operationsRepo: Repository<OperationEntity>,
  ) {}

  async onModuleInit(): Promise<void> {
    const failed = await this.operations.failActiveOperationsOnStartup();
    if (failed > 0) {
      this.logger.warn(`failed ${failed} active operation(s) left by previous backend process`);
    }
    this.timer = setInterval(() => {
      void this.processOne().catch((error) => {
        this.logger.warn(`operation queue interval failed: ${this.errorMessage(error)}`);
      });
    }, WORKER_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async processOne(): Promise<boolean> {
    if (this.processing) return false;
    this.processing = true;
    try {
      const operation = await this.claimNextQueued();
      if (!operation) return false;
      await this.executeOperation(operation);
      return true;
    } finally {
      this.processing = false;
    }
  }

  private async claimNextQueued(): Promise<OperationEntity | null> {
    const candidate = await this.operationsRepo.findOne({
      where: { status: OperationStatus.Queued },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
    if (!candidate) return null;

    return runSerializedTransaction(this.dataSource, async (manager) => {
      const operation = await manager.findOneBy(OperationEntity, { id: candidate.id });
      if (!operation || operation.status !== OperationStatus.Queued) return null;
      operation.status = OperationStatus.Running;
      operation.startedAt = operation.startedAt ?? new Date();
      operation.lastError = null;
      await manager.save(OperationEntity, operation);
      return operation;
    });
  }

  private async executeOperation(operation: OperationEntity): Promise<void> {
    try {
      if (!this.agentGateway.isOnline(operation.serverId)) {
        throw new Error('Agent offline');
      }
      const mainResult = await this.sendCommand(
        operation.serverId,
        this.toEnvelope(operation.commandId, operation.id, operation.commandKind, operation.payloadJson),
      );
      await this.markMainSuccess(operation.id, mainResult);
      const latest = await this.operationsRepo.findOneByOrFail({ id: operation.id });
      const hookResults = await this.executeHooks(latest, mainResult);
      await this.markWaitingReport(latest.id, mainResult, hookResults);
      this.agentGateway.notify(latest.serverId, 'reconcile', { serverId: latest.serverId });
    } catch (error) {
      await this.failOperation(operation.id, error);
    }
  }

  private async executeHooks(
    operation: OperationEntity,
    mainResult: unknown,
  ): Promise<CommandHookResultEntry[]> {
    const hookPlan = this.hookPlan(operation);
    const hookResults = this.hookResults(operation);
    for (let index = hookResults.length; index < hookPlan.length; index += 1) {
      const entry = hookPlan[index];
      const context = {
        operationId: operation.id,
        operationKind: operation.kind,
        commandKind: operation.commandKind,
        serverId: operation.serverId,
        resourceType: operation.resourceType,
        resourceId: operation.resourceId,
        requestedBy: operation.requestedBy,
        request: operation.requestJson,
        payload: operation.payloadJson,
        mainResult,
      };
      const command = await this.hooks.buildCommand(entry, context);
      if (!command) continue;
      const commandId = uuidv4();
      const result = await this.sendCommand(
        operation.serverId,
        this.toEnvelope(commandId, operation.id, command.commandKind, command.payload),
      );
      await this.hooks.mergeResult(entry, context, result);
      const stored: CommandHookResultEntry = {
        name: entry.name,
        commandId,
        commandKind: command.commandKind,
        result: result ?? null,
        completedAt: new Date().toISOString(),
      };
      hookResults.push(stored);
      await this.storeHookResults(operation.id, hookResults);
    }
    return hookResults;
  }

  private async sendCommand<T>(
    serverId: string,
    envelope: AgentCommandEnvelope,
  ): Promise<T> {
    return this.agentGateway.sendCommandEnvelope<T>(
      serverId,
      envelope,
      COMMAND_ACK_TIMEOUT_MS,
    );
  }

  private async markMainSuccess(operationId: string, result: unknown): Promise<void> {
    await runSerializedTransaction(this.dataSource, async (manager) => {
      const operation = await manager.findOneByOrFail(OperationEntity, { id: operationId });
      if (operation.status !== OperationStatus.Running) return;
      operation.resultJson = result ?? null;
      operation.lastError = null;
      await this.operations.runAckSuccess(manager, operation, result);
      await this.domainApplier.applySuccess(manager, operation, result);
      await manager.save(OperationEntity, operation);
    });
  }

  private async markWaitingReport(
    operationId: string,
    result: unknown,
    hookResults: CommandHookResultEntry[],
  ): Promise<void> {
    const now = new Date();
    await runSerializedTransaction(this.dataSource, async (manager) => {
      const operation = await manager.findOneByOrFail(OperationEntity, { id: operationId });
      if (operation.status !== OperationStatus.Running) return;
      operation.status = OperationStatus.WaitingReport;
      operation.resultJson = result ?? null;
      operation.hookResultsJson = hookResults;
      operation.commandCompletedAt = now;
      operation.lastError = null;
      await manager.save(OperationEntity, operation);
    });
    this.operations.clearCallbacks(operationId);
  }

  private async storeHookResults(
    operationId: string,
    hookResults: CommandHookResultEntry[],
  ): Promise<void> {
    await this.operationsRepo.update(operationId, {
      hookResultsJson: hookResults,
    });
  }

  private async failOperation(operationId: string, error: unknown): Promise<void> {
    const completedAt = new Date();
    const lastError = this.errorMessage(error);
    await runSerializedTransaction(this.dataSource, async (manager) => {
      const operation = await manager.findOneBy(OperationEntity, { id: operationId });
      if (!operation || [
        OperationStatus.Succeeded,
        OperationStatus.Failed,
        OperationStatus.Cancelled,
      ].includes(operation.status)) {
        return;
      }
      await this.domainApplier.applyFailure(manager, operation, error);
      await this.operations.runAckFailure(manager, operation, error);
      operation.status = OperationStatus.Failed;
      operation.lastError = lastError;
      operation.completedAt = completedAt;
      await manager.save(OperationEntity, operation);
      await this.resourceLocks.releaseOperation(operation.id, manager);
    });
    this.operations.clearCallbacks(operationId);
  }

  private toEnvelope(
    commandId: string,
    operationId: string,
    commandKind: string,
    payload: unknown,
  ): AgentCommandEnvelope {
    if (!AGENT_COMMAND_KINDS.has(commandKind)) {
      throw new Error(`Invalid agent command kind "${commandKind}" for operation ${operationId}`);
    }
    if (payload === null || typeof payload === 'undefined') {
      throw new Error(`Missing agent command payload for operation ${operationId}`);
    }
    return {
      operationId,
      commandId,
      commandKind: commandKind as AgentCommandKind,
      payload,
    };
  }

  private hookPlan(operation: OperationEntity): CommandHookPlanEntry[] {
    return Array.isArray(operation.hookPlanJson)
      ? operation.hookPlanJson as CommandHookPlanEntry[]
      : [];
  }

  private hookResults(operation: OperationEntity): CommandHookResultEntry[] {
    return Array.isArray(operation.hookResultsJson)
      ? operation.hookResultsJson as CommandHookResultEntry[]
      : [];
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }
}
