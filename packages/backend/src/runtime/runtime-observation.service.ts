import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { ContainerStatus, type ContainerSnapshot, type GpuInfo, type StateReportPayload } from '@nyabase/common';
import { ContainerEntity } from '../entities/container.entity.js';
import { ContainerLifecycleEntity } from '../entities/container-lifecycle.entity.js';
import { RuntimeContainerEntity } from '../entities/runtime-container.entity.js';
import { RuntimeContainerStatEntity } from '../entities/runtime-container-stat.entity.js';
import { RuntimeGpuInventoryEntity } from '../entities/runtime-gpu-inventory.entity.js';
import { RuntimeOrphanService } from './runtime-orphan.service.js';

interface RuntimeContainerObservationInput {
  serverId: string;
  runtimeId: string;
  status: ContainerStatus;
  labels: Record<string, string>;
  ip: string | null;
  stats: unknown | null;
  observedAt: Date;
  specGenerationSeen: number | null;
}

@Injectable()
export class RuntimeObservationService {
  constructor(
    private dataSource: DataSource,
    private orphans: RuntimeOrphanService,
    @InjectRepository(ContainerEntity)
    private containersRepo: Repository<ContainerEntity>,
  ) {}

  async persistStateReport(serverId: string, payload: StateReportPayload): Promise<void> {
    const observedAt = this.reportObservedAt(payload.observedAt);
    const observations = payload.containers.map((container) => this.fromSnapshot(serverId, container, observedAt));
    await this.dataSource.transaction(async (manager) => {
      const desiredIds = observations
        .map((obs) => this.orphans.containerIdFromLabels(obs.labels))
        .filter((id): id is string => Boolean(id));
      const desired = desiredIds.length > 0
        ? await manager.find(ContainerEntity, { where: { id: In(desiredIds) } })
        : [];
      const desiredSet = new Set(desired.map((row) => row.id));
      for (const obs of observations) {
        await this.persistRuntimeContainer(obs, desiredSet.has(this.orphans.containerIdFromLabels(obs.labels) ?? ''), manager);
      }
      if (!payload.incremental) {
        await this.markMissingRuntimeRows(serverId, observations.map((obs) => obs.runtimeId), observedAt, manager);
      }
      await this.persistGpuInventory(serverId, payload as StateReportPayload & { gpus?: GpuInfo[] }, observedAt, manager);
    });
  }

  async persistHelloInventory(serverId: string, gpus: GpuInfo[]): Promise<void> {
    const observedAt = new Date();
    await this.dataSource.transaction((manager) => this.persistGpuInventory(serverId, { gpus }, observedAt, manager));
  }

  private async persistRuntimeContainer(
    obs: RuntimeContainerObservationInput,
    desiredExists: boolean,
    manager: import('typeorm').EntityManager,
  ): Promise<void> {
    const containerId = this.orphans.containerIdFromLabels(obs.labels);
    const existing = await manager.findOne(RuntimeContainerEntity, {
      where: { serverId: obs.serverId, runtimeId: obs.runtimeId },
    });
    const desiredContainer = containerId
      ? await manager.findOne(ContainerEntity, { where: { id: containerId } })
      : null;
    const ownerId = this.nonEmptyString(obs.labels['nyabase.ownerId'])
      ?? this.nonEmptyString(obs.labels['nyabase.owner_id'])
      ?? desiredContainer?.ownerId
      ?? existing?.ownerId
      ?? null;
    const ip = this.nonEmptyString(obs.ip) ?? existing?.ip ?? null;

    await manager.upsert(RuntimeContainerEntity, manager.create(RuntimeContainerEntity, {
      id: `${obs.serverId}:${obs.runtimeId}`,
      serverId: obs.serverId,
      runtimeId: obs.runtimeId,
      containerId,
      ownerId,
      ownerNumericId: this.numberOrNull(obs.labels['nyabase.ownerNumericId']) ?? existing?.ownerNumericId ?? null,
      status: obs.status,
      specGenerationSeen: obs.specGenerationSeen,
      ip,
      labelsJson: obs.labels,
      firstSeenAt: existing?.firstSeenAt ?? obs.observedAt,
      lastSeenAt: obs.observedAt,
      stale: false,
    }), ['serverId', 'runtimeId']);
    if (containerId && desiredExists) {
      await manager.update(ContainerLifecycleEntity, containerId, {
        boundRuntimeId: obs.runtimeId,
        lastTransitionAt: obs.observedAt,
      });
      await this.orphans.clear(obs.serverId, obs.runtimeId, manager);
    } else {
      const reason = this.orphans.classify(obs.labels, desiredExists);
      if (reason) {
        await this.orphans.upsert({
          serverId: obs.serverId,
          runtimeId: obs.runtimeId,
          reason,
          labels: obs.labels,
          observedAt: obs.observedAt,
          cleanupHint: { runtimeId: obs.runtimeId, containerId },
        }, manager);
      }
    }
    if (obs.stats) {
      await manager.save(RuntimeContainerStatEntity, manager.create(RuntimeContainerStatEntity, {
        runtimeContainerId: `${obs.serverId}:${obs.runtimeId}`,
        statsJson: obs.stats,
        observedAt: obs.observedAt,
      }));
    }
  }

  private async markMissingRuntimeRows(
    serverId: string,
    reportedRuntimeIds: string[],
    observedAt: Date,
    manager: import('typeorm').EntityManager,
  ): Promise<void> {
    const existing = await manager.find(RuntimeContainerEntity, { where: { serverId, stale: false } });
    const reported = new Set(reportedRuntimeIds);
    for (const row of existing) {
      if (reported.has(row.runtimeId)) continue;
      // Full reports are collected over time. A container created after this
      // report started cannot appear in it, but operation success may already
      // have inserted a fresh runtime row before the report is persisted. Do
      // not let the older report mark that newer row stale.
      if (row.lastSeenAt >= observedAt) continue;
      await manager.update(RuntimeContainerEntity, row.id, { stale: true, lastSeenAt: observedAt });
    }
  }

  private async persistGpuInventory(
    serverId: string,
    payload: { gpus?: GpuInfo[] },
    observedAt: Date,
    manager: import('typeorm').EntityManager,
  ): Promise<void> {
    for (const gpu of payload.gpus ?? []) {
      await manager.upsert(RuntimeGpuInventoryEntity, manager.create(RuntimeGpuInventoryEntity, {
        serverId,
        gpuIndex: gpu.index,
        uuid: gpu.uuid,
        model: gpu.model,
        totalMemMib: gpu.totalMemMiB,
        observedAt,
      }), ['serverId', 'gpuIndex']);
    }
  }

  private fromSnapshot(serverId: string, snapshot: ContainerSnapshot, observedAt: Date): RuntimeContainerObservationInput {
    const labels = snapshot.labels ?? {};
    const runtimeId = snapshot.spec.runtimeId;
    return {
      serverId,
      runtimeId,
      status: snapshot.status,
      labels,
      ip: snapshot.spec.ip || null,
      stats: snapshot.stats,
      observedAt,
      specGenerationSeen: this.numberOrNull(labels['nyabase.specGeneration'] ?? labels['nyabase.spec_generation']),
    };
  }

  private reportObservedAt(value: unknown): Date {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
      ? new Date(value)
      : new Date();
  }

  private numberOrNull(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private nonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() !== '' ? value : null;
  }
}
