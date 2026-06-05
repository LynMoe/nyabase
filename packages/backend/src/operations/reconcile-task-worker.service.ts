import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import {
  AgentCommandKind,
  HookKind,
  HookStatus,
  OperationKind,
} from '@nyabase/common';
import { DataDirectoryEntity } from '../entities/data-directory.entity.js';
import { DataDirRuntimeObservationEntity } from '../entities/data-dir-runtime-observation.entity.js';
import { DataDiskEntity } from '../entities/data-disk.entity.js';
import { OperationStepEntity } from '../entities/operation-step.entity.js';
import { QuotaDesiredEntity } from '../entities/quota-desired.entity.js';
import { ReconcileTaskEntity } from '../entities/reconcile-task.entity.js';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { runSerializedTransaction } from '../database/serialized-transaction.js';
import { classifyRetry, errorMessage } from './operation-retry-policy.js';
import { OperationOrchestratorService } from './operation-orchestrator.service.js';
import { ResourceLockService } from './resource-lock.service.js';

const WORKER_INTERVAL_MS = 1_000;
const TASK_LOCK_MS = 30_000;

@Injectable()
export class ReconcileTaskWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReconcileTaskWorkerService.name);
  private readonly workerId = `reconcile-${process.pid}-${Math.random().toString(36).slice(2)}`;
  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = false;

  constructor(
    private dataSource: DataSource,
    private orchestrator: OperationOrchestratorService,
    private resourceLocks: ResourceLockService,
    @InjectRepository(ReconcileTaskEntity)
    private tasksRepo: Repository<ReconcileTaskEntity>,
    @InjectRepository(DataDiskEntity)
    private dataDisksRepo: Repository<DataDiskEntity>,
    @InjectRepository(RemoteFsMountEntity)
    private remoteFsMountsRepo: Repository<RemoteFsMountEntity>,
    @InjectRepository(RemoteFsServerAssignmentEntity)
    private remoteFsAssignmentsRepo: Repository<RemoteFsServerAssignmentEntity>,
    @InjectRepository(QuotaDesiredEntity)
    private quotaDesiredRepo: Repository<QuotaDesiredEntity>,
    @InjectRepository(DataDirectoryEntity)
    private dataDirsRepo: Repository<DataDirectoryEntity>,
    @InjectRepository(DataDirRuntimeObservationEntity)
    private dataDirObservationsRepo: Repository<DataDirRuntimeObservationEntity>,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.processBatch(1).catch((error) => {
        this.logger.warn(`reconcile interval failed: ${errorMessage(error)}`);
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
    const task = await this.findNextTask();
    if (!task) return false;

    const lock = await this.resourceLocks.acquire(
      `reconcile:${task.hook}:${task.serverId}:${task.resourceType}:${task.resourceId}`,
      `${this.workerId}:${task.id}`,
      TASK_LOCK_MS,
    );
    if (!lock) {
      await this.deferTask(task, 'Reconcile resource is locked', new Date(Date.now() + 1_000));
      return true;
    }

    try {
      const leased = await this.markTaskRunning(task.id);
      if (!leased) return false;
      await this.processTask(leased);
    } catch (error) {
      await this.failOrRetry(task, error);
    } finally {
      await this.resourceLocks.release(lock);
    }
    return true;
  }

  private async processTask(task: ReconcileTaskEntity): Promise<void> {
    if (task.resourceType === 'server') {
      await this.expandServerTask(task);
      await this.markTaskSucceeded(task, { expanded: true });
      return;
    }

    switch (task.hook) {
      case HookKind.Mounts:
      case HookKind.Ssh:
        await this.markTaskNotApplicable(task, { reason: 'container_reconcile_removed_v2' });
        break;
      case HookKind.RemoteFs:
        await this.enqueueRemoteFsCommand(task);
        break;
      case HookKind.DataDisks:
        await this.enqueueDataDiskCommand(task);
        break;
      case HookKind.Quota:
        await this.enqueueQuotaCommand(task);
        break;
      case HookKind.DataDirs:
        await this.reconcileDataDirTask(task);
        break;
      default:
        await this.markTaskSucceeded(task, { reason: 'no_agent_command_required' });
    }
  }

  private async expandServerTask(task: ReconcileTaskEntity): Promise<void> {
    switch (task.hook) {
      case HookKind.RemoteFs: {
        const assignments = await this.remoteFsAssignmentsRepo.find({
          where: { serverId: task.serverId },
        });
        await Promise.all(assignments.map((assignment) =>
          this.orchestrator.enqueueReconcileTask({
            hook: HookKind.RemoteFs,
            resourceType: 'remote_fs_mount',
            resourceId: assignment.remoteFsMountId,
            serverId: task.serverId,
            result: { source: 'server_task' },
          }),
        ));
        break;
      }
      case HookKind.DataDisks: {
        const disks = await this.dataDisksRepo.find({ where: { serverId: task.serverId } });
        await Promise.all(disks.map((disk) =>
          this.orchestrator.enqueueReconcileTask({
            hook: HookKind.DataDisks,
            resourceType: 'data_disk',
            resourceId: disk.id,
            serverId: task.serverId,
            result: { source: 'server_task' },
          }),
        ));
        break;
      }
      case HookKind.Quota: {
        const desired = await this.quotaDesiredRepo.find({ where: { serverId: task.serverId } });
        await Promise.all(desired.map((quota) =>
          this.orchestrator.enqueueReconcileTask({
            hook: HookKind.Quota,
            resourceType: 'quota',
            resourceId: quota.userId,
            serverId: task.serverId,
            desiredGeneration: quota.generation,
            result: { source: 'server_task' },
          }),
        ));
        break;
      }
      case HookKind.DataDirs:
        await this.reconcileDataDirTask(task);
        return;
      default:
        break;
    }
  }

  private async enqueueRemoteFsCommand(task: ReconcileTaskEntity): Promise<void> {
    const action = this.taskAction(task);
    if (action === 'remove') {
      await this.enqueueTaskCommand(task, {
        operationKind: OperationKind.RemoteFsApply,
        commandKind: AgentCommandKind.RemoteFsRemove,
        resourceType: 'remote_fs_mount',
        resourceId: task.resourceId,
        requestedBy: null,
        payload: { id: task.resourceId, force: true },
      });
      return;
    }

    const mount = await this.remoteFsMountsRepo.findOne({ where: { id: task.resourceId } });
    if (!mount) {
      await this.markTaskNotApplicable(task, { reason: 'remote_fs_mount_missing' });
      return;
    }
    await this.enqueueTaskCommand(task, {
      operationKind: OperationKind.RemoteFsApply,
      commandKind: AgentCommandKind.RemoteFsApply,
      resourceType: 'remote_fs_mount',
      resourceId: mount.id,
      requestedBy: null,
      payload: {
        id: mount.id,
        hostMountPoint: mount.hostMountPoint,
        options: mount.options,
        params: mount.params,
      },
    });
  }

  private async enqueueDataDiskCommand(task: ReconcileTaskEntity): Promise<void> {
    const action = this.taskAction(task);
    if (action === 'remove') {
      await this.enqueueTaskCommand(task, {
        operationKind: OperationKind.DiskApply,
        commandKind: AgentCommandKind.DiskRemove,
        resourceType: 'data_disk',
        resourceId: task.resourceId,
        requestedBy: null,
        payload: { diskId: task.resourceId, force: true },
      });
      return;
    }

    const disk = await this.dataDisksRepo.findOne({
      where: { id: task.resourceId, serverId: task.serverId },
    });
    if (!disk) {
      await this.markTaskNotApplicable(task, { reason: 'data_disk_missing' });
      return;
    }
    await this.enqueueTaskCommand(task, {
      operationKind: OperationKind.DiskApply,
      commandKind: AgentCommandKind.DiskApply,
      resourceType: 'data_disk',
      resourceId: disk.id,
      requestedBy: null,
      payload: {
        diskId: disk.id,
        mountPoint: disk.mountPoint,
        ...(disk.label != null ? { label: disk.label } : {}),
      },
    });
  }

  private async enqueueQuotaCommand(task: ReconcileTaskEntity): Promise<void> {
    const result = this.taskResult(task);
    const desired = await this.quotaDesiredRepo.findOne({
      where: { serverId: task.serverId, userId: task.resourceId },
    });
    const numericUserId = desired?.numericUserId ?? this.numberOrNull(result.numericUserId);
    if (numericUserId == null) {
      await this.markTaskNotApplicable(task, { reason: 'numeric_user_id_missing' });
      return;
    }
    const diskBytes = desired?.limitBytes ?? Number(result.diskBytes ?? 0);
    await this.enqueueTaskCommand(task, {
      operationKind: OperationKind.QuotaApply,
      commandKind: AgentCommandKind.QuotaApply,
      resourceType: 'quota',
      resourceId: task.resourceId,
      requestedBy: null,
      payload: {
        numericUserId,
        diskBytes,
      },
      desiredGeneration: desired?.generation ?? null,
    });
  }

  private async reconcileDataDirTask(task: ReconcileTaskEntity): Promise<void> {
    const expected = await this.loadExpectedDataDirs(task.serverId);
    const reported = await this.loadLatestDataDirObservations(task.serverId);

    const reportedKeys = new Set(reported.map((row) => this.dataDirKey(row.sourceKind, row.sourceId, row.name)));
    const expectedKeys = new Set(expected.map((row) => this.dataDirKey(row.sourceKind, row.sourceId, row.name)));
    const orphans = reported.filter((row) => !expectedKeys.has(this.dataDirKey(row.sourceKind, row.sourceId, row.name)));
    const missing = expected.filter((row) => !reportedKeys.has(this.dataDirKey(row.sourceKind, row.sourceId, row.name)));

    await Promise.all([
      ...reported.map((row) =>
        this.dataDirObservationsRepo.update(row.id, {
          issueKind: expectedKeys.has(this.dataDirKey(row.sourceKind, row.sourceId, row.name)) ? null : 'orphan',
        }),
      ),
      ...missing.map(async (dir) => {
        const now = new Date();
        await this.dataDirObservationsRepo.save(this.dataDirObservationsRepo.create({
          id: uuidv4(),
          serverId: task.serverId,
          dataDirId: dir.dataDirId,
          sourceKind: dir.sourceKind,
          sourceId: dir.sourceId,
          name: dir.name,
          hostPath: dir.hostPath,
          userId: dir.userId,
          reportSeq: await this.nextDataDirReportSeq(task.serverId),
          present: false,
          issueKind: 'missing',
          firstSeenAt: now,
          lastSeenAt: now,
          missingSince: now,
          stale: false,
          lastError: null,
        }));
      }),
    ]);

    await this.markTaskSucceeded(task, {
      reason: 'data_dir_observations_reconciled',
      expected: expected.length,
      reported: reported.length,
      orphans: orphans.length,
      missing: missing.length,
    });
  }

  private async enqueueTaskCommand(
    task: ReconcileTaskEntity,
    input: {
      operationKind: OperationKind;
      commandKind: string;
      resourceType: string;
      resourceId: string;
      requestedBy: string | null;
      payload: unknown;
      desiredGeneration?: number | null;
    },
  ): Promise<void> {
    const stepId = uuidv4();
    const created = await this.orchestrator.createAgentCommand({
      operationKind: input.operationKind,
      commandKind: input.commandKind,
      serverId: task.serverId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      requestedBy: input.requestedBy,
      payload: input.payload,
      desiredGeneration: input.desiredGeneration ?? task.desiredGeneration,
      operationStepId: stepId,
      request: {
        hookTaskId: task.id,
        hook: task.hook,
        resourceType: task.resourceType,
        resourceId: task.resourceId,
        payload: input.payload,
      },
      beforePersist: async (manager, context) => {
        await manager.save(
          OperationStepEntity,
          manager.create(OperationStepEntity, {
            id: stepId,
            operationId: context.operationId,
            stepKey: `${task.hook}:${task.id}`,
            sequence: 0,
            hook: task.hook,
            status: HookStatus.WaitingAgent,
            desiredGeneration: input.desiredGeneration ?? task.desiredGeneration,
            commandId: context.commandId,
            attempts: 0,
            lastError: null,
            result: null,
            startedAt: new Date(),
            completedAt: null,
          }),
        );
        await manager.update(ReconcileTaskEntity, task.id, {
          operationId: context.operationId,
          status: HookStatus.WaitingAgent,
          lastError: null,
        });
      },
    });

    await this.tasksRepo.update(task.id, {
      operationId: created.operationId,
      status: HookStatus.WaitingAgent,
      lastError: null,
    });
  }

  private async findNextTask(): Promise<ReconcileTaskEntity | null> {
    const now = new Date();
    return this.tasksRepo
      .createQueryBuilder('task')
      .where('task.status IN (:...statuses)', {
        statuses: [HookStatus.Pending, HookStatus.Retrying],
      })
      .andWhere('task.nextAttemptAt <= :now', { now })
      .orderBy('task.priority', 'DESC')
      .addOrderBy('task.createdAt', 'ASC')
      .addOrderBy('task.id', 'ASC')
      .getOne();
  }

  private async markTaskRunning(id: string): Promise<ReconcileTaskEntity | null> {
    return runSerializedTransaction(this.dataSource, async (manager) => {
      const task = await manager.findOne(ReconcileTaskEntity, { where: { id } });
      if (!task || ![HookStatus.Pending, HookStatus.Retrying].includes(task.status)) {
        return null;
      }
      task.status = HookStatus.Running;
      task.attempts += 1;
      task.lastError = null;
      await manager.save(task);
      return task;
    });
  }

  private async deferTask(
    task: ReconcileTaskEntity,
    error: unknown,
    nextAttemptAt: Date,
  ): Promise<void> {
    await this.tasksRepo.update(task.id, {
      status: HookStatus.Retrying,
      lastError: errorMessage(error),
      nextAttemptAt,
    });
  }

  private async failOrRetry(task: ReconcileTaskEntity, error: unknown): Promise<void> {
    const decision = classifyRetry(error, task.attempts);
    if (decision.retry && decision.nextAttemptAt) {
      await this.deferTask(task, error, decision.nextAttemptAt);
      return;
    }
    await this.tasksRepo.update(task.id, {
      status: HookStatus.Failed,
      lastError: errorMessage(error),
      nextAttemptAt: new Date(),
    });
  }

  private async markTaskSucceeded(task: ReconcileTaskEntity, result: unknown): Promise<void> {
    task.status = HookStatus.Succeeded;
    task.result = result;
    task.lastError = null;
    task.nextAttemptAt = new Date();
    await this.tasksRepo.save(task);
  }

  private async markTaskNotApplicable(task: ReconcileTaskEntity, result: unknown): Promise<void> {
    task.status = HookStatus.NotApplicable;
    task.result = result;
    task.lastError = null;
    task.nextAttemptAt = new Date();
    await this.tasksRepo.save(task);
  }

  private async resolveHostPath(
    serverId: string,
    sourceKind: 'local' | 'remote',
    sourceId: string,
    _userId: string,
    dirName: string,
  ): Promise<string> {
    if (sourceKind === 'local') {
      const disk = await this.dataDisksRepo.findOne({ where: { id: sourceId, serverId } });
      if (!disk) throw new BadRequestException(`Disk ${sourceId} not found on server ${serverId}`);
      return `${disk.mountPoint}/${dirName}`;
    }
    const assignment = await this.remoteFsAssignmentsRepo.findOne({
      where: { remoteFsMountId: sourceId, serverId },
    });
    if (!assignment) throw new BadRequestException(`Remote FS mount ${sourceId} not found on server ${serverId}`);
    const mount = await this.remoteFsMountsRepo.findOne({ where: { id: sourceId } });
    if (!mount) throw new BadRequestException(`Remote FS mount ${sourceId} not found`);
    return `${mount.hostMountPoint}/${dirName}`;
  }

  private taskResult(task: ReconcileTaskEntity): Record<string, unknown> {
    if (!task.result || typeof task.result !== 'object' || Array.isArray(task.result)) return {};
    return task.result as Record<string, unknown>;
  }

  private taskAction(task: ReconcileTaskEntity): string | null {
    const action = this.taskResult(task).action;
    return typeof action === 'string' ? action : null;
  }

  private async loadExpectedDataDirs(serverId: string): Promise<Array<{
    dataDirId: string;
    sourceKind: 'local' | 'remote';
    sourceId: string;
    name: string;
    userId: string;
    hostPath: string;
  }>> {
    const results: Array<{
      dataDirId: string;
      sourceKind: 'local' | 'remote';
      sourceId: string;
      name: string;
      userId: string;
      hostPath: string;
    }> = [];

    const disks = await this.dataDisksRepo.find({ where: { serverId } });
    if (disks.length > 0) {
      const diskIds = disks.map((disk) => disk.id);
      const mountPoints = new Map(disks.map((disk) => [disk.id, disk.mountPoint]));
      const dirs = await this.dataDirsRepo
        .createQueryBuilder('dir')
        .where('dir.sourceKind = :sourceKind AND dir.sourceId IN (:...sourceIds)', {
          sourceKind: 'local',
          sourceIds: diskIds,
        })
        .getMany();
      for (const dir of dirs) {
        results.push({
          dataDirId: dir.id,
          sourceKind: 'local',
          sourceId: dir.sourceId,
          name: dir.name,
          userId: dir.userId,
          hostPath: `${mountPoints.get(dir.sourceId) ?? ''}/${dir.name}`,
        });
      }
    }

    const assignments = await this.remoteFsAssignmentsRepo.find({ where: { serverId } });
    if (assignments.length > 0) {
      const remoteIds = assignments.map((assignment) => assignment.remoteFsMountId);
      const mounts = await this.remoteFsMountsRepo.find({ where: { id: In(remoteIds) } });
      const mountPoints = new Map(mounts.map((mount) => [mount.id, mount.hostMountPoint]));
      const dirs = await this.dataDirsRepo
        .createQueryBuilder('dir')
        .where('dir.sourceKind = :sourceKind AND dir.sourceId IN (:...sourceIds)', {
          sourceKind: 'remote',
          sourceIds: remoteIds,
        })
        .getMany();
      for (const dir of dirs) {
        results.push({
          dataDirId: dir.id,
          sourceKind: 'remote',
          sourceId: dir.sourceId,
          name: dir.name,
          userId: dir.userId,
          hostPath: `${mountPoints.get(dir.sourceId) ?? ''}/${dir.name}`,
        });
      }
    }

    return results;
  }

  private async loadLatestDataDirObservations(serverId: string): Promise<DataDirRuntimeObservationEntity[]> {
    const rows = await this.dataDirObservationsRepo.find({
      where: { serverId },
      order: {
        sourceKind: 'ASC',
        sourceId: 'ASC',
        name: 'ASC',
        reportSeq: 'DESC',
        lastSeenAt: 'DESC',
      },
    });
    const latest = new Map<string, DataDirRuntimeObservationEntity>();
    for (const row of rows) {
      if (!row.present || row.stale) continue;
      const key = this.dataDirKey(row.sourceKind, row.sourceId, row.name);
      if (!latest.has(key)) latest.set(key, row);
    }
    return [...latest.values()];
  }

  private async nextDataDirReportSeq(serverId: string): Promise<number> {
    const raw = await this.dataDirObservationsRepo
      .createQueryBuilder('observation')
      .select('MAX(observation.reportSeq)', 'max')
      .where('observation.serverId = :serverId', { serverId })
      .getRawOne<{ max: number | string | null }>();
    return Number(raw?.max ?? 0) + 1;
  }

  private dataDirKey(sourceKind: string, sourceId: string, name: string): string {
    return `${sourceKind}|${sourceId}|${name}`;
  }

  private numberOrNull(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }
}
