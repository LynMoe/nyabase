import { Inject, Injectable } from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import type { GpuClaimsPort, GpuHealthPort } from './types.js';

function asHealthObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return asHealthObject(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export type GpuExecutor = Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase>;

@Injectable()
export class GpuClaimsRepository {
  constructor(@Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>) {}

  /** Claims held by one container; `listOccupied` sees the rest of the server. */
  forContainer(
    serverId: string,
    containerId: string,
    executor: GpuExecutor = this.database,
  ): GpuClaimsPort {
    return {
      replace: async (pciAddresses) => {
        await executor
          .deleteFrom('control.container_gpu_claims')
          .where('container_id', '=', containerId)
          .execute();
        if (pciAddresses.length === 0) return;
        await executor
          .insertInto('control.container_gpu_claims')
          .values(pciAddresses.map((pciAddress) => ({
            container_id: containerId,
            server_id: serverId,
            pci_address: pciAddress,
          })))
          .execute();
      },
      listOccupied: async (excludeContainerId = containerId) => {
        let query = executor
          .selectFrom('control.container_gpu_claims')
          .select('pci_address')
          .where('server_id', '=', serverId);
        if (excludeContainerId) {
          query = query.where('container_id', '!=', excludeContainerId);
        }
        const rows = await query.execute();
        return rows.map((row) => row.pci_address);
      },
      count: async () => this.countForServer(serverId, executor),
    };
  }

  health(serverId: string, executor: GpuExecutor = this.database): GpuHealthPort {
    return {
      read: async () => {
        const row = await executor
          .selectFrom('infra.servers')
          .select('gpu_health')
          .where('id', '=', serverId)
          .executeTakeFirst();
        return asHealthObject(row?.gpu_health);
      },
      write: async (health) => {
        await executor
          .updateTable('infra.servers')
          .set({ gpu_health: health })
          .where('id', '=', serverId)
          .execute();
      },
    };
  }

  async countForServer(
    serverId: string,
    executor: GpuExecutor = this.database,
  ): Promise<number> {
    const row = await executor
      .selectFrom('control.container_gpu_claims')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('server_id', '=', serverId)
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  async isEnabled(serverId: string, executor: GpuExecutor = this.database): Promise<boolean> {
    const row = await executor
      .selectFrom('infra.servers')
      .select('gpu_enabled')
      .where('id', '=', serverId)
      .executeTakeFirst();
    return row?.gpu_enabled === true;
  }

  async releaseContainerClaims(
    containerId: string,
    executor: GpuExecutor = this.database,
  ): Promise<void> {
    await executor
      .deleteFrom('control.container_gpu_claims')
      .where('container_id', '=', containerId)
      .execute();
  }
}
