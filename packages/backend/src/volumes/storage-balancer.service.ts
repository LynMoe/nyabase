import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { Kysely } from 'kysely';
import { AccessChangeNotifier } from '../iam/access-resolver.service.js';
import { INCUS_CLIENT_FACTORY, type IncusClientFactory } from '../incus/incus-client.factory.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { DiskChangeNotifier, type DiskChange } from '../storage-pools/disk-mounts.js';
import { loadPlanSnapshot, type UsageSource } from './storage-provisioning.read-model.js';
import { readVolumeUsage } from './volume-ops.js';
import { VolumeProvisioner } from './volume-provisioner.service.js';
import { volumesNeedingUsage } from './volume-provisioning.js';
import { VolumesRepository } from './volumes.repository.js';

const PASS_INTERVAL_MS = 30_000;
const WAKE_DEBOUNCE_MS = 500;
const USAGE_TIMEOUT_MS = 15_000;

/**
 * Keeps every user's storage where the grants say: each pass reads the usage
 * the elastic quotas need (`volumesNeedingUsage`, through the server's agent),
 * then lets the provisioner create, mount and resize. Runs every 30 s and on
 * wakes (IAM writes, a disk enabled or put under maintenance). One pass at a
 * time; wakes during a pass ask for one more. Quotas only change when a pass
 * writes them, so while the Backend is down they stay where they were.
 */
@Injectable()
export class StorageBalancer implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(StorageBalancer.name);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private processing: Promise<void> | null = null;
  private again = false;
  private stopped = true;
  private readonly unsubscribe: Array<() => void> = [];

  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    @Inject(INCUS_CLIENT_FACTORY) private readonly clients: IncusClientFactory,
    private readonly provisioner: VolumeProvisioner,
    private readonly repository: VolumesRepository,
    private readonly access: AccessChangeNotifier,
    private readonly disks: DiskChangeNotifier,
  ) {}

  onApplicationBootstrap(): void {
    this.stopped = false;
    this.unsubscribe.push(this.access.onChange(() => this.wake()));
    this.unsubscribe.push(this.disks.onChange((change) => void this.onDiskChange(change)));
    this.scheduleNext();
    this.wake();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
    if (this.timer) clearTimeout(this.timer);
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.timer = null;
    this.wakeTimer = null;
    await this.processing;
  }

  wake(): void {
    if (this.stopped || this.wakeTimer) return;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      void this.process();
    }, WAKE_DEBOUNCE_MS);
    this.wakeTimer.unref?.();
  }

  /** One pass now (concurrent calls coalesce into one more pass). */
  async process(): Promise<void> {
    if (this.processing) {
      this.again = true;
      return this.processing;
    }
    const processing = (async () => {
      do {
        this.again = false;
        await this.pass();
      } while (this.again && !this.stopped);
    })();
    this.processing = processing;
    try {
      await processing;
    } finally {
      if (this.processing === processing) this.processing = null;
    }
  }

  private async onDiskChange(change: DiskChange): Promise<void> {
    try {
      if (change.maintenanceChanged) await this.provisioner.rewriteContainersOnDisk(change.disk);
    } catch (error) {
      this.logger.warn(`disk=${change.disk.id} container rewrite failed: ${String(error)}`);
    }
    this.wake();
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.wake();
      this.scheduleNext();
    }, PASS_INTERVAL_MS);
    this.timer.unref?.();
  }

  private async pass(): Promise<void> {
    try {
      const { snapshot, usageSources } = await loadPlanSnapshot(this.database);
      const usage = await this.readUsage(volumesNeedingUsage(snapshot), usageSources);
      const outcome = await this.provisioner.run(usage);
      if (outcome.created + outcome.mounted + outcome.resized > 0) {
        this.logger.log(
          `storage pass created=${outcome.created} mounted=${outcome.mounted} resized=${outcome.resized}`
          + ` pathConflicts=${outcome.pathConflicts.length}`,
        );
      }
    } catch (error) {
      this.logger.warn(`storage pass failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Live usage of the given local volumes, per server in parallel; unknown where the server cannot answer. */
  private async readUsage(
    volumeIds: readonly string[],
    sources: ReadonlyMap<string, UsageSource>,
  ): Promise<Map<string, number | null>> {
    const usage = new Map<string, number | null>();
    const byServer = new Map<string, UsageSource[]>();
    for (const id of volumeIds) {
      const source = sources.get(id);
      if (!source) continue;
      byServer.set(source.serverId, [...(byServer.get(source.serverId) ?? []), source]);
    }
    await Promise.all([...byServer.entries()].map(async ([serverId, list]) => {
      let client;
      try {
        client = await this.clients.get(serverId);
      } catch {
        return;
      }
      for (const source of list) {
        try {
          const used = await withTimeout(readVolumeUsage(client, source.pool, source.incusName), USAGE_TIMEOUT_MS);
          const value = used === null ? null : Number(used);
          usage.set(source.volumeId, value);
          await this.repository.setUsedBytes(source.volumeId, value);
        } catch {
          usage.set(source.volumeId, null);
        }
      }
    }));
    return usage;
  }
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
