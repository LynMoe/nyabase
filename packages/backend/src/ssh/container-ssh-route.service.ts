import { Injectable } from '@nestjs/common';
import {
  ContainerStatus,
  type ContainerSnapshot,
  type SshProxyRuntimeRouteSnapshot,
} from '@nyabase/common';
import {
  ContainerControlRepository,
  type ContainerSshRouteRecord,
} from '../containers/container-control.repository.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { sql } from 'kysely';

@Injectable()
export class ContainerSshRouteService {
  constructor(
    private readonly containers: ContainerControlRepository,
    private readonly transactions: PgTransactionManager,
  ) {}

  async updateFromStateReport(
    serverId: string,
    snapshots: ContainerSnapshot[],
    _receivedAtMs: number,
  ): Promise<void> {
    await this.transactions.run(async (transaction) => {
      const clock = await sql<{ now: Date }>`
        select clock_timestamp() as now
      `.execute(transaction);
      const observedAt = new Date(clock.rows[0]!.now);
      const addresses = [...new Set(
        snapshots.map((snapshot) => snapshot.runtime.ip).filter(Boolean),
      )];
      const claims = await this.containers.activeNetworkClaims(
        { addresses },
        transaction,
      );
      const byContainerId = new Map(claims
        .filter((claim) => claim.ownerKind === 'container' && claim.containerId)
        .map((claim) => [claim.containerId!, claim]));
      const byAddress = new Map<string, typeof claims>();
      for (const claim of claims) {
        const rows = byAddress.get(claim.address) ?? [];
        rows.push(claim);
        byAddress.set(claim.address, rows);
      }
      const routes = snapshots.map((snapshot) => {
        const containerId = snapshot.labels?.['nyabase.container_id'];
        const reservation = containerId
          ? byContainerId.get(containerId)
          : undefined;
        const activeForAddress = byAddress.get(snapshot.runtime.ip) ?? [];
        if (
          !reservation
          || reservation.serverId !== serverId
          || reservation.address !== snapshot.runtime.ip
          || activeForAddress.length !== 1
          || activeForAddress[0]?.id !== reservation.id
        ) return null;
        return this.routeFromSnapshot(serverId, snapshot, observedAt);
      }).filter((row): row is ContainerSshRouteRecord => row !== null);
      await this.containers.replaceServerRoutes(serverId, routes, transaction);
    });
  }

  clearServer(
    serverId: string,
    executor?: Parameters<ContainerControlRepository['deleteRoutes']>[1],
  ): Promise<void> {
    return this.containers.deleteRoutes({ serverId }, executor);
  }

  clearAll(): Promise<void> {
    return this.containers.deleteRoutes();
  }

  findByContainerIds(
    containerIds: string[],
  ): Promise<Map<string, ContainerSshRouteRecord>> {
    return this.containers.routes(containerIds);
  }

  async snapshotRows(): Promise<SshProxyRuntimeRouteSnapshot[]> {
    return (await this.containers.listRoutes()).map((row) => ({
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
  ): ContainerSshRouteRecord | null {
    const containerId = snapshot.labels?.['nyabase.container_id'];
    if (!containerId) return null;
    return {
      containerId,
      serverId,
      runtimeId: snapshot.runtime.runtimeId,
      macvlanIp: snapshot.runtime.ip || null,
      runtimeStatus: snapshot.status ?? ContainerStatus.Unknown,
      sshStatus: snapshot.sshServer.status,
      appliedInternalKeyGeneration:
        snapshot.sshServer.appliedKeyGeneration ?? null,
      containerHostKeyFingerprint:
        snapshot.sshServer.hostKeyFingerprint ?? null,
      lastError: snapshot.sshServer.lastError ?? null,
      observedAt,
    };
  }
}
