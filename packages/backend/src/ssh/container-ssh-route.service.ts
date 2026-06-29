import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  ContainerStatus,
  type ContainerSnapshot,
  type SshProxyRuntimeRouteSnapshot,
} from '@nyabase/common';
import { In, Repository } from 'typeorm';
import { ContainerSshRouteEntity } from '../entities/container-ssh-route.entity.js';

@Injectable()
export class ContainerSshRouteService {
  constructor(
    @InjectRepository(ContainerSshRouteEntity)
    private routesRepo: Repository<ContainerSshRouteEntity>,
  ) {}

  async updateFromStateReport(
    serverId: string,
    containers: ContainerSnapshot[],
    observedAtMs: number,
    incremental: boolean,
  ): Promise<void> {
    const observedAt = new Date(observedAtMs);
    const rows = containers
      .map((container) => this.routeFromSnapshot(serverId, container, observedAt))
      .filter((row): row is ContainerSshRouteEntity => row !== null);
    if (!incremental) {
      await this.routesRepo.delete({ serverId });
    }
    if (rows.length > 0) {
      await this.routesRepo.upsert(rows, ['containerId']);
    }
  }

  async findByContainerIds(containerIds: string[]): Promise<Map<string, ContainerSshRouteEntity>> {
    if (containerIds.length === 0) return new Map();
    const rows = await this.routesRepo.find({ where: { containerId: In(containerIds) } });
    return new Map(rows.map((row) => [row.containerId, row]));
  }

  async snapshotRows(): Promise<SshProxyRuntimeRouteSnapshot[]> {
    const rows = await this.routesRepo.find();
    return rows.map((row) => ({
      containerId: row.containerId,
      serverId: row.serverId,
      runtimeId: row.runtimeId,
      macvlanIp: row.macvlanIp,
      runtimeStatus: row.runtimeStatus,
      sshStatus: row.sshStatus,
      appliedInternalKeyGeneration: row.appliedInternalKeyGeneration,
      containerHostKeyFingerprint: row.containerHostKeyFingerprint,
      observedAt: row.observedAt.toISOString(),
    }));
  }

  private routeFromSnapshot(
    serverId: string,
    snapshot: ContainerSnapshot,
    observedAt: Date,
  ): ContainerSshRouteEntity | null {
    const labels = snapshot.labels ?? {};
    const containerId = labels['nyabase.containerId'] ?? labels['nyabase.container_id'];
    if (!containerId) return null;
    return this.routesRepo.create({
      containerId,
      serverId,
      runtimeId: snapshot.spec.runtimeId,
      macvlanIp: snapshot.spec.ip || null,
      runtimeStatus: snapshot.status ?? ContainerStatus.Unknown,
      sshStatus: snapshot.sshServer.status,
      appliedInternalKeyGeneration: snapshot.sshServer.appliedKeyGeneration ?? null,
      containerHostKeyFingerprint: snapshot.sshServer.hostKeyFingerprint ?? null,
      lastError: snapshot.sshServer.lastError ?? null,
      observedAt,
    });
  }
}
