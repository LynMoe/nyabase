import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import type { GpuClaimsPort, GpuHealthPort } from './admit.js';

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

  /** Claims held by one container. */
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

  /** Distinct cards claimed on the server (a shared card counts once). */
  async countForServer(
    serverId: string,
    executor: GpuExecutor = this.database,
  ): Promise<number> {
    const row = await executor
      .selectFrom('control.container_gpu_claims')
      .select((eb) => eb.fn.count<number>('pci_address').distinct().as('count'))
      .where('server_id', '=', serverId)
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  /**
   * Live containers whose instance spec carries a GPU contribution (a card or
   * the NVIDIA runtime; see `gpuStateOccupies`). Mirrors the disable trigger.
   */
  async countOccupyingContainers(
    serverId: string,
    executor: GpuExecutor = this.database,
  ): Promise<number> {
    const row = await executor
      .selectFrom('control.containers')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('server_id', '=', serverId)
      .where('lifecycle_phase', 'in', ['provisioning', 'active'])
      .where(sql<boolean>`gpu_state IS NOT NULL AND (
        gpu_state -> 'nvidiaRuntime' = 'true'::jsonb
        OR jsonb_array_length(gpu_state -> 'pciAddresses') > 0
      )`)
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  /**
   * `gpu_enabled` read under a share lock on the server row, so a concurrent
   * disable waits for (and then sees) the claims and GPU state this
   * transaction writes.
   */
  async lockEnabled(serverId: string, executor: GpuExecutor): Promise<boolean> {
    const row = await executor
      .selectFrom('infra.servers')
      .select('gpu_enabled')
      .where('id', '=', serverId)
      .forShare()
      .executeTakeFirst();
    return row?.gpu_enabled === true;
  }

  async isEnabled(serverId: string, executor: GpuExecutor = this.database): Promise<boolean> {
    const row = await executor
      .selectFrom('infra.servers')
      .select('gpu_enabled')
      .where('id', '=', serverId)
      .executeTakeFirst();
    return row?.gpu_enabled === true;
  }

  /** PCI addresses currently claimed by one container. */
  async listForContainer(
    containerId: string,
    executor: GpuExecutor = this.database,
  ): Promise<string[]> {
    const rows = await executor
      .selectFrom('control.container_gpu_claims')
      .select('pci_address')
      .where('container_id', '=', containerId)
      .execute();
    return rows.map((row) => row.pci_address);
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
