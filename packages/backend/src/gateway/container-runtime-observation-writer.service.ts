import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import {
  type DataDirReportPayload,
  type DockerDaemonStatus,
  type HelloPayload,
  type RemoteFsMountStatus,
  type ContainerSnapshot,
  type StateReportPayload,
} from '@nyabase/common';
import { ContainerRuntimeObservationEntity } from '../entities/container-runtime-observation.entity.js';
import { DataDirRuntimeObservationEntity } from '../entities/data-dir-runtime-observation.entity.js';
import { DataDiskRuntimeObservationEntity } from '../entities/data-disk-runtime-observation.entity.js';
import { QuotaRuntimeObservationEntity } from '../entities/quota-runtime-observation.entity.js';
import { RemoteFsRuntimeObservationEntity } from '../entities/remote-fs-runtime-observation.entity.js';
import { DockerDaemonRuntimeObservationEntity } from '../entities/docker-daemon-runtime-observation.entity.js';
import { runSerializedTransaction } from '../database/serialized-transaction.js';
import { LifecycleHookRegistryService } from '../operations/lifecycle-hook-registry.service.js';
import { RuntimeObservationService } from '../runtime/runtime-observation.service.js';

type Labels = Record<string, string>;
@Injectable()
export class ContainerRuntimeObservationWriter {
  private readonly logger = new Logger(ContainerRuntimeObservationWriter.name);
  private readonly serverWriteChains = new Map<string, Promise<void>>();

  constructor(
    private dataSource: DataSource,
    @Inject(forwardRef(() => LifecycleHookRegistryService))
    private lifecycleHooks: LifecycleHookRegistryService,
    private runtimeObservation: RuntimeObservationService,
  ) {}

  async persistStateReport(serverId: string, payload: StateReportPayload): Promise<void> {
    await this.enqueueServerWrite(serverId, async () => {
      await this.runtimeObservation.persistStateReport(serverId, payload);
      await this.persistStateReportNow(serverId, payload);
    });
  }

  private async enqueueServerWrite(serverId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.serverWriteChains.get(serverId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(work);
    this.serverWriteChains.set(serverId, current);
    try {
      await current;
    } finally {
      if (this.serverWriteChains.get(serverId) === current) this.serverWriteChains.delete(serverId);
    }
  }

  private async persistStateReportNow(
    serverId: string,
    payload: StateReportPayload,
  ): Promise<void> {
    const observedAt = this.reportObservedAt(payload.observedAt);
    const reportedContainers = this.dedupeByRuntimeId(payload.containers);
    const reportedRuntimeIds = new Set(reportedContainers.map((c) => c.spec.runtimeId));

    await runSerializedTransaction(this.dataSource, async (manager) => {
      const reportSeq = await this.nextStateReportSeq(manager, serverId);
      const latestByRuntimeId = await this.loadLatestByRuntimeId(manager, serverId);

      const observations = reportedContainers.map((container) => {
        const labels = this.extractLabels(container);
        const labelsValid = this.labelsAreValid(labels, serverId);
        const previous = latestByRuntimeId.get(container.spec.runtimeId);

        return manager.create(ContainerRuntimeObservationEntity, {
          id: uuidv4(),
          serverId,
          containerId: labelsValid ? this.containerIdFromLabels(labels) : null,
          dockerId: container.spec.runtimeId,
          reportSeq,
          status: container.status,
          stats: container.stats ?? null,
          sshServer: container.sshServer ?? null,
          labels,
          labelsValid,
          specGenerationSeen: this.specGenerationSeen(labelsValid ? labels : null, container),
          firstSeenAt: previous?.firstSeenAt ?? observedAt,
          lastSeenAt: observedAt,
          missingSince: null,
          stale: false,
        });
      });

      if (observations.length > 0) {
        await manager.save(ContainerRuntimeObservationEntity, observations);
      }

      await this.persistDiskObservations(manager, serverId, payload.disks, reportSeq, observedAt);
      await this.persistRemoteFsObservations(manager, serverId, payload.remoteFsMounts ?? [], reportSeq, observedAt);
      await this.persistQuotaObservations(manager, serverId, payload.xfsProjects, reportSeq, observedAt);

      if (!payload.incremental) {
        await this.markSupersededLatestObservations(
          manager,
          latestByRuntimeId,
          reportedRuntimeIds,
          observedAt,
        );
      }
    });

    if (!payload.incremental) {
      await this.lifecycleHooks.enqueueFullReport(serverId);
    }
  }

  async persistHello(serverId: string, payload: HelloPayload): Promise<void> {
    await this.runtimeObservation.persistHelloInventory(serverId, payload.gpus);
    const observedAt = new Date();
    await runSerializedTransaction(this.dataSource, async (manager) => {
      const reportSeq = await this.nextGenericReportSeq(
        manager,
        DataDiskRuntimeObservationEntity,
        serverId,
      );
      await this.persistDiskObservations(manager, serverId, payload.disks, reportSeq, observedAt);
    });
    await this.lifecycleHooks.enqueueAgentReconnect(serverId);
  }

  async persistDataDirReport(serverId: string, payload: DataDirReportPayload): Promise<void> {
    await this.enqueueServerWrite(serverId, async () => {
      const observedAt = new Date();
      await runSerializedTransaction(this.dataSource, async (manager) => {
        const reportSeq = await this.nextGenericReportSeq(
          manager,
          DataDirRuntimeObservationEntity,
          serverId,
        );
        const latest = await manager.find(DataDirRuntimeObservationEntity, {
          where: { serverId },
          order: { sourceKind: 'ASC', sourceId: 'ASC', name: 'ASC', reportSeq: 'DESC' },
        });
        const firstSeen = new Map<string, Date>();
        for (const row of latest) {
          const key = this.dataDirKey(row.sourceKind, row.sourceId, row.name);
          if (!firstSeen.has(key)) firstSeen.set(key, row.firstSeenAt);
        }

        await manager.update(DataDirRuntimeObservationEntity, { serverId, stale: false }, {
          stale: true,
          lastSeenAt: observedAt,
        });

        const rows = payload.dirs.map((dir) => {
          const key = this.dataDirKey(dir.sourceKind, dir.sourceId, dir.name);
          return manager.create(DataDirRuntimeObservationEntity, {
            id: uuidv4(),
            serverId,
            dataDirId: null,
            sourceKind: dir.sourceKind,
            sourceId: dir.sourceId,
            name: dir.name,
            hostPath: dir.hostPath,
            userId: null,
            reportSeq,
            present: true,
            issueKind: null,
            firstSeenAt: firstSeen.get(key) ?? observedAt,
            lastSeenAt: observedAt,
            missingSince: null,
            stale: false,
            lastError: null,
          });
        });
        if (rows.length > 0) await manager.save(DataDirRuntimeObservationEntity, rows);
      });
      await this.lifecycleHooks.enqueueDataDirReport(serverId);
    });
  }

  async persistContainerEvent(_serverId: string, _runtimeId: string, _action: string): Promise<void> {
    return;
  }

  async persistRemoteFsMountStatus(
    serverId: string,
    status: RemoteFsMountStatus,
  ): Promise<void> {
    const observedAt = new Date();
    await runSerializedTransaction(this.dataSource, async (manager) => {
      const reportSeq = await this.nextGenericReportSeq(
        manager,
        RemoteFsRuntimeObservationEntity,
        serverId,
      );
      await this.persistRemoteFsObservations(manager, serverId, [status], reportSeq, observedAt);
    });
  }

  async persistDockerDaemonStatus(
    serverId: string,
    status: DockerDaemonStatus,
  ): Promise<void> {
    const observedAt = new Date();
    const checkedAt = new Date(status.checkedAt);
    await runSerializedTransaction(this.dataSource, async (manager) => {
      await manager.upsert(DockerDaemonRuntimeObservationEntity, manager.create(DockerDaemonRuntimeObservationEntity, {
        serverId,
        state: status.state,
        unitFileInSync: status.unitFileInSync,
        enabled: status.enabled,
        active: status.active,
        pid: status.pid,
        dockerRoot: status.dockerRoot,
        socketPath: status.socketPath,
        serverVersion: status.serverVersion,
        storageDriver: status.storageDriver,
        lastError: status.lastError,
        checkedAt,
        observedAt,
      }), ['serverId']);
    });
  }

  private dedupeByRuntimeId(containers: ContainerSnapshot[]): ContainerSnapshot[] {
    const byRuntimeId = new Map<string, ContainerSnapshot>();
    for (const container of containers) {
      byRuntimeId.set(container.spec.runtimeId, container);
    }
    return Array.from(byRuntimeId.values());
  }

  private async nextStateReportSeq(
    manager: EntityManager,
    serverId: string,
  ): Promise<number> {
    const observationEntities = [
      ContainerRuntimeObservationEntity,
      DataDiskRuntimeObservationEntity,
      RemoteFsRuntimeObservationEntity,
      QuotaRuntimeObservationEntity,
    ];
    let maxSeq = 0;
    for (const entity of observationEntities) {
      maxSeq = Math.max(maxSeq, await this.maxGenericReportSeq(manager, entity, serverId));
    }
    return maxSeq + 1;
  }

  private async maxGenericReportSeq(
    manager: EntityManager,
    entity: Function,
    serverId: string,
  ): Promise<number> {
    const raw = await manager
      .createQueryBuilder()
      .select('MAX(observation.reportSeq)', 'max')
      .from(entity, 'observation')
      .where('observation.serverId = :serverId', { serverId })
      .getRawOne<{ max: number | string | null }>();
    return this.toSafeInteger(raw?.max) ?? 0;
  }

  private async nextGenericReportSeq(
    manager: EntityManager,
    entity: Function,
    serverId: string,
  ): Promise<number> {
    return (await this.maxGenericReportSeq(manager, entity, serverId)) + 1;
  }

  private async persistDiskObservations(
    manager: EntityManager,
    serverId: string,
    disks: StateReportPayload['disks'],
    reportSeq: number,
    observedAt: Date,
  ): Promise<void> {
    if (disks.length === 0) return;
    await manager.save(
      DataDiskRuntimeObservationEntity,
      disks.map((disk) => manager.create(DataDiskRuntimeObservationEntity, {
        id: uuidv4(),
        serverId,
        diskId: disk.diskId,
        mountPoint: disk.mountPoint,
        label: disk.label ?? null,
        totalBytes: disk.totalBytes,
        usedBytes: disk.usedBytes,
        pquotaEnabled: disk.pquotaEnabled,
        reportSeq,
        lastSeenAt: observedAt,
        stale: false,
        lastError: null,
      })),
    );
  }

  private async persistRemoteFsObservations(
    manager: EntityManager,
    serverId: string,
    statuses: RemoteFsMountStatus[],
    reportSeq: number,
    observedAt: Date,
  ): Promise<void> {
    if (statuses.length === 0) return;
    await manager.save(
      RemoteFsRuntimeObservationEntity,
      statuses.map((status) => manager.create(RemoteFsRuntimeObservationEntity, {
        id: uuidv4(),
        serverId,
        remoteFsMountId: status.id,
        hostMountPoint: status.hostMountPoint,
        status: status.status,
        error: status.error ?? null,
        totalBytes: status.totalBytes ?? null,
        usedBytes: status.usedBytes ?? null,
        reportSeq,
        lastSeenAt: observedAt,
        stale: false,
      })),
    );
  }

  private async persistQuotaObservations(
    manager: EntityManager,
    serverId: string,
    projects: StateReportPayload['xfsProjects'],
    reportSeq: number,
    observedAt: Date,
  ): Promise<void> {
    if (projects.length === 0) return;
    await manager.save(
      QuotaRuntimeObservationEntity,
      projects.map((project) => manager.create(QuotaRuntimeObservationEntity, {
        id: uuidv4(),
        serverId,
        userId: null,
        numericUserId: project.numericUserId,
        projectId: project.projectId,
        usedBytes: project.usedBytes,
        hardLimitBytes: project.hardLimitBytes,
        reportSeq,
        lastSeenAt: observedAt,
        stale: false,
        drift: null,
      })),
    );
  }

  private async loadLatestByRuntimeId(
    manager: EntityManager,
    serverId: string,
  ): Promise<Map<string, ContainerRuntimeObservationEntity>> {
    const observations = await manager.find(ContainerRuntimeObservationEntity, {
      where: { serverId },
      order: {
        dockerId: 'ASC',
        reportSeq: 'DESC',
        lastSeenAt: 'DESC',
      },
    });
    const latestByRuntimeId = new Map<string, ContainerRuntimeObservationEntity>();
    for (const observation of observations) {
      if (!latestByRuntimeId.has(observation.dockerId)) {
        latestByRuntimeId.set(observation.dockerId, observation);
      }
    }
    return latestByRuntimeId;
  }

  private async markSupersededLatestObservations(
    manager: EntityManager,
    latestByRuntimeId: Map<string, ContainerRuntimeObservationEntity>,
    reportedRuntimeIds: Set<string>,
    supersededAt: Date,
  ): Promise<void> {
    for (const observation of latestByRuntimeId.values()) {
      const absentFromReport = !reportedRuntimeIds.has(observation.dockerId);

      await manager.update(ContainerRuntimeObservationEntity, observation.id, {
        stale: true,
        ...(absentFromReport
          ? { missingSince: observation.missingSince ?? supersededAt }
          : {}),
      });
    }
  }

  private dataDirKey(sourceKind: string, sourceId: string, name: string): string {
    return `${sourceKind}\0${sourceId}\0${name}`;
  }

  private extractLabels(container: ContainerSnapshot): Labels | null {
    const rawLabels =
      (container as { labels?: unknown }).labels
      ?? (container.spec as { labels?: unknown }).labels;
    if (rawLabels === null || typeof rawLabels !== 'object' || Array.isArray(rawLabels)) {
      return null;
    }

    const labels: Labels = {};
    for (const [key, value] of Object.entries(rawLabels)) {
      if (typeof value !== 'string') return null;
      labels[key] = value;
    }
    return labels;
  }

  private labelsAreValid(labels: Labels | null, serverId: string): boolean {
    if (!labels) return false;
    if (!Object.keys(labels).some((key) => key.startsWith('nyabase.'))) return false;

    const labeledServerId = labels['nyabase.server_id'];
    if (labeledServerId !== undefined && labeledServerId !== serverId) return false;

    const managed = labels['nyabase.managed'];
    if (managed !== undefined && managed !== 'true') return false;

    const containerId = labels['nyabase.container_id'];
    if (containerId !== undefined && containerId.trim() === '') return false;

    const specGeneration = labels['nyabase.spec_generation'];
    if (specGeneration !== undefined && this.toSafeInteger(specGeneration) === null) {
      return false;
    }

    return true;
  }

  private containerIdFromLabels(labels: Labels | null): string | null {
    const containerId = labels?.['nyabase.container_id'];
    return containerId && containerId.trim() !== '' ? containerId : null;
  }

  private specGenerationSeen(
    labels: Labels | null,
    container: ContainerSnapshot,
  ): number | null {
    return this.toSafeInteger(labels?.['nyabase.spec_generation'])
      ?? this.toSafeInteger(container.spec.specVersion);
  }

  private toSafeInteger(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const numeric = typeof value === 'number' ? value : Number(value);
    return Number.isSafeInteger(numeric) ? numeric : null;
  }


  private reportObservedAt(value: unknown): Date {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
      ? new Date(value)
      : new Date();
  }
}
