import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import {
  AgentCommandKind,
  OperationKind,
  OperationStatus,
} from '@nyabase/common';
import { CommandHookRegistry } from '../command-hooks/command-hook-registry.service.js';
import { OperationEntity } from '../entities/operation.entity.js';
import { runSerializedTransaction } from '../database/serialized-transaction.js';
import { ResourceKeyService } from './resource-key.service.js';
import { ResourceLockService } from './resource-lock.service.js';
import type {
  EnqueueCommandInput,
  EnqueueCommandResult,
  OperationCallbackContext,
  OperationPersistContext,
} from './operation-types.js';

export interface DispatchAgentCommandPersistContext {
  operationId: string;
  commandId: string;
}

export interface DispatchAgentCommandInput<T = unknown> {
  operationKind: OperationKind;
  commandKind: AgentCommandKind | string;
  serverId: string;
  resourceType: string;
  resourceId: string;
  requestedBy: string | null;
  payload: unknown;
  request?: unknown;
  resourceKey?: string;
  resourceKeys?: string[];
  unlockReportKind?: 'state' | 'data_dir' | null;
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

export type DurableOperationResult<T = unknown> = EnqueueCommandResult<T>;

type OperationCallbacks<T = unknown> = Pick<EnqueueCommandInput<T>, 'onAckSuccess' | 'onAckFailure'>;

@Injectable()
export class OperationsService {
  private readonly operationCallbacks = new Map<string, OperationCallbacks>();

  constructor(
    private dataSource: DataSource,
    @InjectRepository(OperationEntity)
    private operationsRepo: Repository<OperationEntity>,
    private resourceKeys: ResourceKeyService,
    private resourceLocks: ResourceLockService,
    private commandHooks: CommandHookRegistry,
  ) {}

  async dispatchAgentCommand<T>(
    input: DispatchAgentCommandInput<T>,
    _execute?: () => Promise<T>,
  ): Promise<DurableOperationResult<T>> {
    const baseResourceKeys = [
      ...(input.resourceKeys ?? []),
      input.resourceKey,
    ].filter((value): value is string => typeof value === 'string' && value.trim() !== '');

    return this.enqueueCommand<T>({
      kind: input.operationKind,
      commandKind: input.commandKind,
      serverId: input.serverId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      requestedBy: input.requestedBy,
      payload: input.payload,
      request: input.request,
      baseResourceKeys,
      unlockReportKind: input.unlockReportKind ?? this.defaultUnlockReportKind(input.operationKind, input.resourceType),
      beforeCommit: input.beforePersist,
      onAckSuccess: input.onCommandSucceeded
        ? (manager, result, context) => input.onCommandSucceeded!(manager, result, {
          operationId: context.operationId,
          commandId: context.commandId,
        })
        : undefined,
      onAckFailure: input.onCommandFailed
        ? (manager, error, context) => input.onCommandFailed!(manager, error, {
          operationId: context.operationId,
          commandId: context.commandId,
        })
        : undefined,
    });
  }

  async enqueueCommand<T>(input: EnqueueCommandInput<T>): Promise<EnqueueCommandResult<T>> {
    const operationId = uuidv4();
    const commandId = uuidv4();

    await runSerializedTransaction(this.dataSource, async (manager) => {
      await this.persistCommand(manager, input, operationId, commandId);
    });
    this.registerCallbacks(operationId, input);

    return {
      ok: true,
      operationId,
      status: OperationStatus.Queued,
      result: null,
    };
  }

  async enqueueCommandInTransaction<T>(
    manager: EntityManager,
    input: EnqueueCommandInput<T>,
  ): Promise<EnqueueCommandResult<T>> {
    const operationId = uuidv4();
    const commandId = uuidv4();
    await this.persistCommand(manager, input, operationId, commandId);
    this.registerCallbacks(operationId, input);
    return {
      ok: true,
      operationId,
      status: OperationStatus.Queued,
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
      await this.resourceLocks.releaseOperation(operationId, manager);
      if (updateResource) {
        await updateResource(manager);
      }
    });
    this.clearCallbacks(operationId);
  }

  async getOperationForUser(requesterId: string, operationId: string) {
    const operation = await this.operationsRepo.findOne({ where: { id: operationId } });
    if (!operation) throw new NotFoundException('Operation not found');
    if (operation.requestedBy !== requesterId) throw new ForbiddenException();
    return this.operationView(operation);
  }

  async getOperationForAdmin(operationId: string) {
    const operation = await this.operationsRepo.findOne({ where: { id: operationId } });
    if (!operation) throw new NotFoundException('Operation not found');
    return this.operationView(operation);
  }

  async activeOperationForResource(resourceKeys: string[]): Promise<OperationEntity | null> {
    const locks = await this.resourceLocks.findActiveByResourceKeys(resourceKeys);
    if (locks.length === 0) return null;
    const operationIds = [...new Set(locks.map((lock) => lock.operationId))];
    const operations = await this.operationsRepo.find({
      where: { id: In(operationIds) },
      order: { createdAt: 'ASC' },
    });
    return operations.find((operation) => !this.isTerminal(operation.status)) ?? null;
  }

  async failActiveOperationsOnStartup(): Promise<number> {
    const activeStatuses = [
      OperationStatus.Queued,
      OperationStatus.Running,
      OperationStatus.WaitingReport,
    ];
    const now = new Date();
    return runSerializedTransaction(this.dataSource, async (manager) => {
      const active = await manager.find(OperationEntity, {
        where: { status: In(activeStatuses) },
      });
      if (active.length === 0) return 0;
      const ids = active.map((operation) => operation.id);
      await manager.update(OperationEntity, { id: In(ids) }, {
        status: OperationStatus.Failed,
        lastError: 'Backend restarted before operation completed',
        completedAt: now,
      });
      await this.resourceLocks.releaseOperations(ids, manager);
      return ids.length;
    });
  }

  operationContext(
    input: Pick<EnqueueCommandInput, 'kind' | 'commandKind' | 'serverId' | 'resourceType' | 'resourceId' | 'requestedBy' | 'request' | 'payload'>,
    operationId: string,
    commandId: string,
    mainResult: unknown | null,
  ) {
    return {
      operationId,
      operationKind: input.kind,
      commandKind: input.commandKind,
      serverId: input.serverId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      requestedBy: input.requestedBy,
      request: input.request ?? null,
      payload: input.payload ?? null,
      mainResult,
    };
  }

  callbackContext(operation: OperationEntity): OperationCallbackContext {
    return {
      operationId: operation.id,
      commandId: operation.commandId,
      operationKind: operation.kind,
      commandKind: operation.commandKind,
      serverId: operation.serverId,
      resourceType: operation.resourceType,
      resourceId: operation.resourceId,
    };
  }

  async runAckSuccess<T>(
    manager: EntityManager,
    operation: OperationEntity,
    result: T,
  ): Promise<void> {
    const callback = this.operationCallbacks.get(operation.id)?.onAckSuccess;
    if (!callback) return;
    await callback(manager, result, this.callbackContext(operation));
  }

  async runAckFailure(
    manager: EntityManager,
    operation: OperationEntity,
    error: unknown,
  ): Promise<void> {
    const callback = this.operationCallbacks.get(operation.id)?.onAckFailure;
    if (!callback) return;
    await callback(manager, error, this.callbackContext(operation));
  }

  clearCallbacks(operationId: string): void {
    this.operationCallbacks.delete(operationId);
  }

  defaultUnlockReportKind(kind: OperationKind, resourceType: string): 'state' | 'data_dir' | null {
    if (resourceType === 'datadir') return 'data_dir';
    switch (kind) {
      case OperationKind.ContainerCreate:
      case OperationKind.ContainerStart:
      case OperationKind.ContainerStop:
      case OperationKind.ContainerRestart:
      case OperationKind.ContainerDelete:
      case OperationKind.ContainerUpdateMounts:
      case OperationKind.ContainerReconcileSsh:
      case OperationKind.DiskApply:
      case OperationKind.RemoteFsApply:
      case OperationKind.QuotaApply:
      case OperationKind.ImagePull:
        return 'state';
      default:
        return 'state';
    }
  }

  toOperationSummary(operation: OperationEntity) {
    return this.operationView(operation);
  }

  private operationView(operation: OperationEntity) {
    return {
      id: operation.id,
      kind: operation.kind,
      status: operation.status,
      resourceType: operation.resourceType,
      resourceId: operation.resourceId,
      serverId: operation.serverId,
      requestedBy: operation.requestedBy,
      resourceKeys: operation.resourceKeysJson ?? [],
      commandId: operation.commandId,
      commandKind: operation.commandKind,
      request: this.sanitizeValue(operation.requestJson),
      result: this.sanitizeValue(operation.resultJson),
      hookResults: this.sanitizeValue(operation.hookResultsJson),
      lastError: operation.lastError,
      createdAt: this.toIso(operation.createdAt),
      startedAt: this.toIso(operation.startedAt),
      commandCompletedAt: this.toIso(operation.commandCompletedAt),
      completedAt: this.toIso(operation.completedAt),
    };
  }

  private async persistCommand<T>(
    manager: EntityManager,
    input: EnqueueCommandInput<T>,
    operationId: string,
    commandId: string,
  ): Promise<void> {
    const persistContext: OperationPersistContext = { operationId, commandId };
    if (input.beforeCommit) {
      await input.beforeCommit(manager, persistContext);
    }
    const context = this.operationContext(input, operationId, commandId, null);
    const planned = await this.commandHooks.plan(context);
    const resourceKeys = this.sortedKeys([
      ...(input.baseResourceKeys?.length
        ? input.baseResourceKeys
        : [this.resourceKeys.generic(input.serverId, input.resourceType, input.resourceId)]),
      ...planned.resourceKeys,
    ]);
    await this.resourceLocks.insertForOperation(manager, {
      operationId,
      serverId: input.serverId,
      resourceKeys,
    });
    await manager.save(OperationEntity, manager.create(OperationEntity, {
      id: operationId,
      kind: input.kind,
      serverId: input.serverId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      requestedBy: input.requestedBy,
      commandId,
      commandKind: input.commandKind,
      resourceKeysJson: resourceKeys,
      unlockReportKind: input.unlockReportKind ?? this.defaultUnlockReportKind(input.kind, input.resourceType),
      status: OperationStatus.Queued,
      requestJson: input.request ?? null,
      payloadJson: input.payload ?? null,
      hookPlanJson: planned.hookPlan,
      hookResultsJson: [],
      resultJson: null,
      lastError: null,
      startedAt: null,
      commandCompletedAt: null,
      completedAt: null,
    }));
  }

  private sortedKeys(keys: string[]): string[] {
    return [...new Set(keys.filter((key) => key.trim() !== ''))].sort();
  }

  private registerCallbacks<T>(operationId: string, input: EnqueueCommandInput<T>): void {
    if (!input.onAckSuccess && !input.onAckFailure) return;
    this.operationCallbacks.set(operationId, {
      onAckSuccess: input.onAckSuccess as OperationCallbacks['onAckSuccess'],
      onAckFailure: input.onAckFailure,
    });
  }

  private isTerminal(status: OperationStatus): boolean {
    return [
      OperationStatus.Succeeded,
      OperationStatus.Failed,
      OperationStatus.Cancelled,
    ].includes(status);
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
      if (/secret|password|token|keytext|publickeys|privatekey|internalprivatekey/i.test(key)) {
        output[key] = '[redacted]';
      } else {
        output[key] = this.redactValue(entry);
      }
    }
    return output;
  }
}
