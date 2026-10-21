import { numberValue } from '../platform/domain-utils.js';
import type { IncusClientFactory } from '../incus/incus-client.factory.js';
import type { Kysely } from 'kysely';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { listEligibleDestroyExecutors } from './eligible-destroy-executors.js';
import type { VolumeRow } from './volume-dtos.js';
import { normalizeObservedVolumeUsage, type VolumeDriver } from './volume-usage.js';
import type { VolumesRepository } from './volumes.repository.js';

export type UsageObservation =
  | { status: 'unavailable' }
  | { status: 'observed'; usedBytes: bigint | null };

interface UsageCandidate {
  serverId: string;
  poolName: string;
  driver: VolumeDriver;
  resizeFamily: 'quota_online' | 'block_backed';
}

export interface VolumeUsageProbeDeps {
  readonly database: Kysely<NyabaseDatabase>;
  readonly repository: VolumesRepository;
  readonly clients: IncusClientFactory;
}

function incusUsageToBigint(value: unknown): bigint | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  return null;
}

async function usageCandidates(
  deps: VolumeUsageProbeDeps,
  volume: VolumeRow,
): Promise<UsageCandidate[]> {
  const candidates: UsageCandidate[] = [];
  const seen = new Set<string>();
  const placementRows = await deps.repository.listPlacementsWithPool(volume.id);
  for (const row of placementRows) {
    if (
      (row.catalog_state === 'present' || row.catalog_state === 'ensuring')
      && row.server_status === 'online'
    ) {
      candidates.push({
        serverId: row.server_id,
        poolName: row.pool_name,
        driver: row.driver,
        resizeFamily: row.resize_family === 'block_backed' ? 'block_backed' : 'quota_online',
      });
      seen.add(row.server_id);
    }
  }
  if (volume.shared_backend_id) {
    const eligible = await listEligibleDestroyExecutors(deps.database, volume.shared_backend_id);
    for (const executor of eligible) {
      if (seen.has(executor.server_id)) continue;
      candidates.push({
        serverId: executor.server_id,
        poolName: executor.pool_name,
        driver: 'cephfs',
        resizeFamily: 'quota_online',
      });
      seen.add(executor.server_id);
    }
  }
  return candidates;
}

async function readVolumeStateUsage(
  deps: VolumeUsageProbeDeps,
  candidate: UsageCandidate,
  volume: VolumeRow,
): Promise<{ status: 'observed'; usedBytes: bigint | null } | { status: 'error' }> {
  let client;
  try {
    client = await deps.clients.get(candidate.serverId);
  } catch {
    return { status: 'error' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const state = (await client.getStorageVolumeState(
      candidate.poolName,
      'custom',
      volume.incus_name,
      { signal: controller.signal },
    )).metadata;
    return {
      status: 'observed',
      usedBytes: normalizeObservedVolumeUsage({
        resizeFamily: candidate.resizeFamily,
        driver: candidate.driver,
        usedBytes: incusUsageToBigint(state.usage?.used),
        totalBytes: incusUsageToBigint(state.usage?.total),
        currentSizeBytes: BigInt(numberValue(volume.size_bytes)),
      }),
    };
  } catch {
    return { status: 'error' };
  } finally {
    clearTimeout(timer);
  }
}

/** Ask the servers that can reach a shared volume for its live usage; the first answer wins. */
export async function observeSharedVolumeUsage(
  deps: VolumeUsageProbeDeps,
  volume: VolumeRow,
): Promise<UsageObservation> {
  const candidates = await usageCandidates(deps, volume);
  for (const candidate of candidates) {
    const result = await readVolumeStateUsage(deps, candidate, volume);
    if (result.status === 'observed') return result;
  }
  return { status: 'unavailable' };
}
