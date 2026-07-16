import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  ContainerStatus,
  type ContainerSnapshot,
  type SshProxyRuntimeRouteSnapshot,
} from '@nyabase/common';
import { DataSource, In, Repository } from 'typeorm';
import { ContainerSshRouteEntity } from '../entities/container-ssh-route.entity.js';
import { runSerializedTransaction } from '../database/serialized-transaction.js';
import { NetworkAddressClaimEntity } from '../entities/network-address-claim.entity.js';

@Injectable()
export class ContainerSshRouteService {
  constructor(
    @InjectRepository(ContainerSshRouteEntity)
    private routesRepo: Repository<ContainerSshRouteEntity>,
    private dataSource: DataSource,
  ) {}

  async updateFromStateReport(
    serverId: string,
    containers: ContainerSnapshot[],
    receivedAtMs: number,
  ): Promise<void> {
    // Route TTL is a Backend-local freshness decision. Never compare the
    // Agent host's wall clock with the Backend clock; preserve Agent
    // observedAt only in the state-report evidence/cache.
    const observedAt = new Date(receivedAtMs);
    await runSerializedTransaction(this.dataSource, async (manager) => {
      const containerIds = containers
        .map((container) => container.labels?.['nyabase.container_id'])
        .filter((id): id is string => Boolean(id));
      const addresses = containers.map((container) => container.runtime.ip);
      const claims = containerIds.length === 0
        ? []
        : await manager.find(NetworkAddressClaimEntity, {
          where: [
            { ownerId: In(containerIds), state: 'active' },
            { address: In(addresses), state: 'active' },
          ],
        });
      const byContainerId = new Map(claims.filter((claim) => claim.ownerKind === 'container').map((claim) => [
        claim.ownerId,
        claim,
      ]));
      const rows = containers
        .map((container) => {
          const containerId = container.labels?.['nyabase.container_id'];
          const reservation = containerId ? byContainerId.get(containerId) : undefined;
          const activeForAddress = claims.filter((claim) => claim.address === container.runtime.ip);
          if (
            !reservation
            || reservation.serverId !== serverId
            || reservation.address !== container.runtime.ip
            || activeForAddress.length !== 1
            || activeForAddress[0]?.id !== reservation.id
          ) return null;
          return this.routeFromSnapshot(serverId, container, observedAt);
        })
        .filter((row): row is ContainerSshRouteEntity => row !== null);
      await manager.delete(ContainerSshRouteEntity, { serverId });
      if (rows.length > 0) await manager.upsert(ContainerSshRouteEntity, rows, ['containerId']);
    });
  }

  async clearServer(serverId: string): Promise<void> {
    await this.routesRepo.delete({ serverId });
  }

  async clearAll(): Promise<void> {
    await this.routesRepo.clear();
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
    const containerId = labels['nyabase.container_id'];
    if (!containerId) return null;
    return this.routesRepo.create({
      containerId,
      serverId,
      runtimeId: snapshot.runtime.runtimeId,
      macvlanIp: snapshot.runtime.ip || null,
      runtimeStatus: snapshot.status ?? ContainerStatus.Unknown,
      sshStatus: snapshot.sshServer.status,
      appliedInternalKeyGeneration: snapshot.sshServer.appliedKeyGeneration ?? null,
      containerHostKeyFingerprint: snapshot.sshServer.hostKeyFingerprint ?? null,
      lastError: snapshot.sshServer.lastError ?? null,
      observedAt,
    });
  }
}
