import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type {
  SharedBackendCatalogInspectDto,
  SharedVolumeCatalogInspectDto,
} from '@nyabase/common';
import type { Kysely } from 'kysely';
import { INCUS_CLIENT_FACTORY, type IncusClientFactory } from '../incus/incus-client.factory.js';
import { IncusError } from '../incus/index.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { assertSharedExists } from './volume-access.js';
import { occupancyForCatalogItem } from './shared-volume-inspect.js';
import { VolumesRepository } from './volumes.repository.js';

const INSPECT_TIMEOUT_MS = 5_000;
const MANAGED_VOLUME_NAME = /^nyv-[0-9a-f]{32}$/;

async function withInspectTimeout<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INSPECT_TIMEOUT_MS);
  try {
    return await work(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** Read-only comparison of the control-plane catalog with what Incus servers actually hold. */
@Injectable()
export class SharedVolumeCatalogInspectService {
  constructor(
    private readonly repository: VolumesRepository,
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    @Inject(INCUS_CLIENT_FACTORY) private readonly clients: IncusClientFactory,
  ) {}

  /** Is the custom volume present on the server's Incus? null when it cannot be asked. */
  private async probeIncusVolume(
    serverId: string,
    poolName: string,
    incusName: string,
  ): Promise<boolean | null> {
    try {
      const client = await this.clients.get(serverId);
      return await withInspectTimeout(async (signal) => {
        try {
          await client.getStorageVolume(poolName, 'custom', incusName, { signal });
          return true;
        } catch (error) {
          return error instanceof IncusError && error.code === 'INCUS_NOT_FOUND' ? false : null;
        }
      });
    } catch {
      return null;
    }
  }

  async inspectSharedVolumeCatalogs(volumeId: string): Promise<SharedVolumeCatalogInspectDto> {
    const volume = await this.repository.findById(volumeId);
    assertSharedExists(volume);
    const pools = await this.database
      .selectFrom('infra.storage_pools as p')
      .innerJoin('infra.servers as s', 's.id', 'p.server_id')
      .select([
        's.id as server_id',
        's.name as server_name',
        's.status as server_status',
        'p.id as pool_id',
        'p.incus_name as pool_name',
      ])
      .where('p.shared_backend_id', '=', volume.shared_backend_id)
      .where('p.driver', '=', 'cephfs')
      .where('p.shareable', '=', true)
      .where('p.registered', '=', true)
      .where('s.status', '=', 'online')
      .orderBy('s.id', 'asc')
      .orderBy('p.id', 'asc')
      .execute();
    const placements = await this.repository.listPlacements(volumeId);
    const placementByServer = new Map(placements.map((row) => [row.server_id, row]));
    const attachedServers = new Set(
      (await this.repository.listAttachmentContainerServers([volumeId]))
        .map((row) => row.server_id),
    );
    const items: SharedVolumeCatalogInspectDto['items'] = [];
    for (const pool of pools) {
      const placement = placementByServer.get(pool.server_id);
      const pgCatalogState = placement?.catalog_state === 'present' || placement?.catalog_state === 'ensuring'
        ? placement.catalog_state
        : 'absent';
      const incusPresent = await this.probeIncusVolume(
        pool.server_id,
        pool.pool_name,
        volume.incus_name,
      );
      const occupancy = occupancyForCatalogItem({
        pgCatalogState,
        incusPresent,
        hasAttachment: attachedServers.has(pool.server_id),
      });
      if (occupancy === 'skip') continue;
      items.push({
        serverId: pool.server_id,
        serverName: pool.server_name,
        serverStatus: pool.server_status as SharedVolumeCatalogInspectDto['items'][number]['serverStatus'],
        poolId: pool.pool_id,
        poolName: pool.pool_name,
        pgCatalogState,
        incusPresent,
        occupancy,
      });
    }
    return {
      volumeId: volume.id,
      incusName: volume.incus_name,
      sharedBackendId: volume.shared_backend_id!,
      items,
    };
  }

  /** Names of the custom volumes one server's pool holds, or null when it cannot be listed. */
  private async listPoolVolumeNames(serverId: string, poolName: string): Promise<string[] | null> {
    try {
      const client = await this.clients.get(serverId);
      const listed = await withInspectTimeout(async (signal) => (
        await client.listStorageVolumes(poolName, 'custom', 1, { signal })
      ).metadata as Array<{ name?: string } | string>);
      return listed.map((entry) => (typeof entry === 'string'
        ? (entry.split('/').filter(Boolean).at(-1) ?? '')
        : (entry.name ?? '')));
    } catch {
      return null;
    }
  }

  async inspectSharedBackendCatalogs(backendId: string): Promise<SharedBackendCatalogInspectDto> {
    const backend = await this.database.selectFrom('infra.shared_backends')
      .select('id')
      .where('id', '=', backendId)
      .executeTakeFirst();
    if (!backend) throw new NotFoundException('Shared backend not found');
    const pools = await this.database
      .selectFrom('infra.storage_pools as p')
      .innerJoin('infra.servers as s', 's.id', 'p.server_id')
      .select([
        's.id as server_id',
        's.name as server_name',
        'p.id as pool_id',
        'p.incus_name as pool_name',
      ])
      .where('p.shared_backend_id', '=', backendId)
      .where('p.driver', '=', 'cephfs')
      .where('p.shareable', '=', true)
      .where('p.registered', '=', true)
      .where('s.status', '=', 'online')
      .orderBy('s.id', 'asc')
      .execute();
    const volumes = await this.repository.listSharedBackendVolumes(backendId);
    const volumeByName = new Map(volumes.map((row) => [row.incus_name, row.id]));
    const attachments = await this.repository.listAttachmentContainerServers(
      volumes.map((row) => row.id),
    );
    const inUse = new Set(attachments.map((row) => `${row.volume_id}:${row.server_id}`));
    const items: SharedBackendCatalogInspectDto['items'] = [];
    for (const pool of pools) {
      const names = await this.listPoolVolumeNames(pool.server_id, pool.pool_name);
      if (names === null) continue;
      for (const name of names) {
        if (!MANAGED_VOLUME_NAME.test(name)) continue;
        const volumeId = volumeByName.get(name) ?? null;
        const occupancy = volumeId === null
          ? 'dangling_incus'
          : inUse.has(`${volumeId}:${pool.server_id}`)
            ? 'in_use'
            : 'cache';
        items.push({
          serverId: pool.server_id,
          serverName: pool.server_name,
          poolId: pool.pool_id,
          poolName: pool.pool_name,
          incusName: name,
          volumeId,
          occupancy,
        });
      }
    }
    return { sharedBackendId: backendId, items };
  }
}
