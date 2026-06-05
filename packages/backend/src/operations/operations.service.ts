import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import {
  OperationKind,
  OperationStatus,
} from '@nyabase/common';
import { AgentCommandOutboxEntity } from '../entities/agent-command-outbox.entity.js';
import { OperationEntity } from '../entities/operation.entity.js';
import { OperationStepEntity } from '../entities/operation-step.entity.js';
import { runSerializedTransaction } from '../database/serialized-transaction.js';
import { OperationOrchestratorService } from './operation-orchestrator.service.js';

export interface DispatchAgentCommandPersistContext {
  operationId: string;
  commandId: string;
  idempotencyKey: string;
}

export interface DispatchAgentCommandInput<T = unknown> {
  operationKind: OperationKind;
  commandKind: string;
  serverId: string;
  resourceType: string;
  resourceId: string;
  requestedBy: string | null;
  payload: unknown;
  request?: unknown;
  desiredGeneration?: number | null;
  resourceKey?: string;
  beforePersist?: (
    manager: EntityManager,
    context: DispatchAgentCommandPersistContext,
  ) => Promise<void>;
  onCommandSucceeded?: (
    manager: EntityManager,
    result: T,
    context: DispatchAgentCommandPersistContext,
  ) => Promise<void>;
  onCommandFailed?: (
    manager: EntityManager,
    error: unknown,
    context: DispatchAgentCommandPersistContext,
  ) => Promise<void>;
}

export interface DurableOperationResult<T = unknown> {
  operationId: string;
  status: OperationStatus;
  result: T | null;
}

@Injectable()
export class OperationsService {
  constructor(
    private dataSource: DataSource,
    @InjectRepository(OperationEntity)
    private operationsRepo: Repository<OperationEntity>,
    @InjectRepository(OperationStepEntity)
    private stepsRepo: Repository<OperationStepEntity>,
    @InjectRepository(AgentCommandOutboxEntity)
    private outboxRepo: Repository<AgentCommandOutboxEntity>,
    private orchestrator: OperationOrchestratorService,
  ) {}

  async dispatchAgentCommand<T>(
    input: DispatchAgentCommandInput<T>,
    _execute?: () => Promise<T>,
  ): Promise<DurableOperationResult<T>> {
    const created = await this.orchestrator.createAgentCommand(input);
    return {
      operationId: created.operationId,
      status: created.status,
      result: null,
    };
  }

  async markOperationFailed(
    operationId: string,
    error: unknown,
    updateResource?: (manager: EntityManager) => Promise<void>,
  ): Promise<void> {
    const completedAt = new Date();
    const lastError = this.errorMessage(error);
    await runSerializedTransaction(this.dataSource, async (manager) => {
      await manager.update(OperationEntity, operationId, {
        status: OperationStatus.Failed,
        lastError,
        completedAt,
      });
      if (updateResource) {
        await updateResource(manager);
      }
    });
  }

  async getOperationForUser(requesterId: string, operationId: string) {
    const operation = await this.operationsRepo.findOne({ where: { id: operationId } });
    if (!operation) throw new NotFoundException('Operation not found');

    const isRequester = operation.requestedBy === requesterId;
    if (!isRequester) throw new ForbiddenException();

    return this.operationView(operation);
  }

  async getOperationForAdmin(operationId: string) {
    const operation = await this.operationsRepo.findOne({ where: { id: operationId } });
    if (!operation) throw new NotFoundException('Operation not found');
    return this.operationView(operation);
  }

  private async operationView(operation: OperationEntity) {
    const [steps, commands] = await Promise.all([
      this.stepsRepo.find({
        where: { operationId: operation.id },
        order: { sequence: 'ASC', createdAt: 'ASC' },
      }),
      this.outboxRepo.find({
        where: { operationId: operation.id },
        order: { createdAt: 'ASC' },
      }),
    ]);

    return {
      id: operation.id,
      kind: operation.kind,
      status: operation.status,
      resourceType: operation.resourceType,
      resourceId: operation.resourceId,
      serverId: operation.serverId,
      requestedBy: operation.requestedBy,
      request: this.sanitizeValue(operation.request),
      result: this.sanitizeValue(operation.result),
      attempts: operation.attempts,
      lastError: operation.lastError,
      createdAt: this.toIso(operation.createdAt),
      startedAt: this.toIso(operation.startedAt),
      completedAt: this.toIso(operation.completedAt),
      steps: steps.map((step) => ({
        id: step.id,
        stepKey: step.stepKey,
        sequence: step.sequence,
        hook: step.hook,
        status: step.status,
        desiredGeneration: step.desiredGeneration,
        commandId: step.commandId,
        attempts: step.attempts,
        lastError: step.lastError,
        result: this.sanitizeValue(step.result),
        createdAt: this.toIso(step.createdAt),
        updatedAt: this.toIso(step.updatedAt),
        startedAt: this.toIso(step.startedAt),
        completedAt: this.toIso(step.completedAt),
      })),
      commands: commands.map((command) => ({
        id: command.id,
        operationStepId: command.operationStepId,
        serverId: command.serverId,
        resourceKey: command.resourceKey,
        commandKind: command.commandKind,
        idempotencyKey: command.idempotencyKey,
        desiredGeneration: command.desiredGeneration,
        payload: this.sanitizeValue(command.payload),
        status: command.status,
        attempts: command.attempts,
        lastError: command.lastError,
        nextAttemptAt: this.toIso(command.nextAttemptAt),
        sentAt: this.toIso(command.sentAt),
        completedAt: this.toIso(command.completedAt),
        createdAt: this.toIso(command.createdAt),
        updatedAt: this.toIso(command.updatedAt),
      })),
    };
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }

  private toIso(value: Date | string | null | undefined): string | null {
    if (!value) return null;
    if (value instanceof Date) return value.toISOString();
    return new Date(value).toISOString();
  }

  private sanitizeValue(value: unknown): unknown {
    return this.redactValue(value);
  }

  private redactValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((entry) => this.redactValue(entry));
    if (!value || typeof value !== 'object') return value;
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (/secret|password|token|keytext|publickeys/i.test(key)) {
        output[key] = '[redacted]';
      } else {
        output[key] = this.redactValue(entry);
      }
    }
    return output;
  }
}
