import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { GrantServerProfileDto } from '@nyabase/common';
import { isRecord, numberValue } from '../platform/domain-utils.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { INCUS_CLIENT_FACTORY, type IncusClientFactory } from '../incus/incus-client.factory.js';
import { gpuInventoryFromResources } from '../gpu/inventory.js';
import { isLocalPoolRow } from '../storage-pools/storage-pool-capability.js';

const LIVE_READ_TIMEOUT_MS = 8_000;

export interface LiveHardware {
  cpuModels: Array<{ name: string; sockets: number }>;
  memoryBytes: number | null;
  gpus: Array<{ pciAddress: string; model: string }>;
}

/** CPU models (per distinct socket name), physical memory and NVIDIA cards from Incus `/1.0/resources`. */
export function liveHardwareFromResources(resources: unknown): LiveHardware {
  const models = new Map<string, number>();
  const sockets = isRecord(resources) && isRecord(resources.cpu) && Array.isArray(resources.cpu.sockets)
    ? resources.cpu.sockets
    : [];
  for (const socket of sockets) {
    const name = isRecord(socket) && typeof socket.name === 'string' && socket.name.trim()
      ? socket.name.trim()
      : 'CPU';
    models.set(name, (models.get(name) ?? 0) + 1);
  }
  const memory = isRecord(resources) && isRecord(resources.memory) ? resources.memory.total : undefined;
  return {
    cpuModels: [...models].map(([name, count]) => ({ name, sockets: count })),
    memoryBytes: typeof memory === 'number' && Number.isSafeInteger(memory) && memory > 0 ? memory : null,
    gpus: gpuInventoryFromResources(resources).map((card) => ({ pciAddress: card.pciAddress, model: card.model })),
  };
}

/**
 * The bundle form's reference panel: what the server has. Hardware is read
 * live through the agent; an unreachable server still gets the stored CPU
 * topology, pools and last observed GPUs.
 */
@Injectable()
export class GrantServerProfileService {
  private readonly logger = new Logger(GrantServerProfileService.name);

  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    @Inject(INCUS_CLIENT_FACTORY) private readonly clients: IncusClientFactory,
  ) {}

  async profile(serverId: string): Promise<GrantServerProfileDto> {
    const server = await this.database.selectFrom('infra.servers')
      .select(['id', 'cpu_topology', 'reserved_cpus', 'system_pool_id', 'gpu_enabled', 'observed_gpu_pci_addresses'])
      .where('id', '=', serverId)
      .executeTakeFirst();
    if (!server) throw new NotFoundException('Server not found');
    const pools = (await this.database.selectFrom('infra.storage_pools')
      .select(['id', 'incus_name', 'display_name', 'driver', 'shareable', 'shared_backend_id', 'total_bytes', 'used_bytes'])
      .where('server_id', '=', serverId)
      .where('registered', '=', true)
      .orderBy('incus_name')
      .execute()).filter(isLocalPoolRow);
    const live = await this.readLive(serverId);
    const topology = server.cpu_topology ?? [];
    const reserved = new Set(server.reserved_cpus);
    const logical = topology.length === 0 ? null : topology.length;
    return {
      serverId,
      live: live !== null,
      cpu: {
        models: live?.cpuModels ?? [],
        logical,
        reserved: topology.filter((cpu) => reserved.has(cpu.id)).length,
        allocatable: logical === null ? null : topology.filter((cpu) => !reserved.has(cpu.id)).length,
      },
      memoryBytes: live?.memoryBytes ?? null,
      pools: pools.map((pool) => ({
        poolId: pool.id,
        name: pool.display_name || pool.incus_name,
        driver: pool.driver,
        system: pool.id === server.system_pool_id,
        totalBytes: pool.total_bytes === null ? null : numberValue(pool.total_bytes),
        usedBytes: pool.used_bytes === null ? null : numberValue(pool.used_bytes),
      })),
      gpu: {
        enabled: server.gpu_enabled === true,
        cards: live
          ? live.gpus
          : server.observed_gpu_pci_addresses.map((pciAddress) => ({ pciAddress, model: null })),
      },
    };
  }

  private async readLive(serverId: string): Promise<LiveHardware | null> {
    try {
      const client = await this.clients.get(serverId);
      const resources = await client.getResources({ signal: AbortSignal.timeout(LIVE_READ_TIMEOUT_MS) });
      return liveHardwareFromResources(resources.metadata);
    } catch (error) {
      this.logger.debug(`Live hardware read for ${serverId} failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
}
