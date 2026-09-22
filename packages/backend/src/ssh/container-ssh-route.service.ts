import { Injectable } from '@nestjs/common';
import type { SshProxyInstanceRouteSnapshot } from '@nyabase/common';
import {
  ContainerControlRepository,
  type ContainerSshRouteRecord,
} from '../containers/container-control.repository.js';

@Injectable()
export class ContainerSshRouteService {
  constructor(
    private readonly containers: ContainerControlRepository,
  ) {}

  clearServer(
    serverId: string,
    executor?: Parameters<ContainerControlRepository['deleteRoutes']>[1],
  ): Promise<void> {
    return this.containers.deleteRoutes({ serverId }, executor);
  }

  clearAll(): Promise<void> {
    return this.containers.deleteRoutes();
  }

  async findByContainerIds(
    containerIds: string[],
  ): Promise<Map<string, ContainerSshRouteRecord>> {
    const rows = await this.containers.routes(containerIds);
    return new Map(rows.map((row) => [row.containerId, row]));
  }

  async snapshotRows(): Promise<SshProxyInstanceRouteSnapshot[]> {
    return (await this.containers.listRoutes()).map((row) => ({
      containerId: row.containerId,
      serverId: row.serverId,
      instanceName: row.instanceName,
      routedIp: row.routedIp || null,
      status: row.runtimeStatus as SshProxyInstanceRouteSnapshot['status'],
      sshStatus: row.sshStatus,
      observedAt: row.observedAt.toISOString(),
    }));
  }
}
