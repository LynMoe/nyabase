import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuditAction } from '@nyabase/common';
import { AccessChangeNotifier } from '../iam/access-resolver.service.js';
import { SYSTEM_ACTOR, type Actor } from '../iam/actor.js';
import { AuditService } from '../iam/audit.service.js';
import { ReconcileClaimRepository } from '../reconcile/reconcile-claim.repository.js';
import {
  AccessLapseRepository,
  lapseWork,
  type LapseCandidate,
} from './access-lapse.repository.js';
import { UserServerResourcePurgeService } from './user-server-resource-purge.service.js';
import { ProxySnapshotNotifierService } from '../proxy-snapshots/proxy-snapshot-notifier.service.js';

const SCAN_INTERVAL_MS = 60_000;
const SCAN_INTERVAL_JITTER_MS = 15_000;
const MAX_PAIRS_PER_PASS = 128;

/**
 * Enforces access lapses. A user who owns containers or volumes on a server,
 * storage pool or shared backend without current coverage (grant expired,
 * revoked, removed from the group, group deleted, or the user disabled: coverage
 * is a current grant held by an active user) is in a 14-day grace that starts
 * at `lapsed_at`:
 *
 *  - no ledger row yet: open it (`lapsed_at` = the detection time; never
 *    moved afterwards);
 *  - in grace and not yet enforced, or exposed again (an administrator
 *    started a container or re-attached a volume during the grace): on a
 *    server, stop the user's running containers there; on a storage pool or
 *    shared backend, detach the user's volumes there from their containers,
 *    which keep running and are never deleted for it (`stopped_at` keeps the
 *    first enforcement time);
 *  - grace over and not purged: on a server, purge the user's containers and
 *    local volumes there; on a pool or backend, destroy the user's volumes there;
 *  - purged pool or backend whose volumes are still attached (a detach whose
 *    re-drive was not due at the purge): detach them again, with the re-drive
 *    backoff, until the attachments are gone and the destroys can run;
 *  - coverage back: delete the row (nothing is restarted or re-attached).
 *
 * Runs every minute and right after IAM writes commit (`AccessChangeNotifier`).
 * Each pair is leased through `ReconcileClaimRepository` (resource_type
 * `access_lapse`), so replicas never work on the same pair; stop and purge go
 * through the same code as the operator purge, as `SYSTEM_ACTOR` (NULL
 * attribution in audit rows and intents).
 */
@Injectable()
export class AccessLapseProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AccessLapseProcessor.name);
  private readonly workerId = `access-lapse:${randomUUID()}`;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private wakeTimer: ReturnType<typeof setImmediate> | null = null;
  private processing: Promise<number> | null = null;
  private stopped = false;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly lapses: AccessLapseRepository,
    private readonly claims: ReconcileClaimRepository,
    private readonly purge: UserServerResourcePurgeService,
    private readonly audit: AuditService,
    private readonly changes: AccessChangeNotifier,
    private readonly proxySnapshots: ProxySnapshotNotifierService,
  ) {}

  onModuleInit(): void {
    this.stopped = false;
    this.unsubscribe = this.changes.onChange(() => this.wake());
    this.scheduleNext();
    this.wake();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) clearTimeout(this.timer);
    if (this.wakeTimer) clearImmediate(this.wakeTimer);
    this.timer = null;
    this.wakeTimer = null;
    await this.processing;
  }

  wake(): void {
    if (this.stopped || this.wakeTimer) return;
    this.wakeTimer = setImmediate(() => {
      this.wakeTimer = null;
      if (!this.stopped) void this.process();
    });
  }

  /** One pass; returns the number of pairs it acted on. Concurrent calls share a pass. */
  async process(): Promise<number> {
    if (this.stopped) return 0;
    if (this.processing) return this.processing;
    const processing = this.pass();
    this.processing = processing;
    try {
      return await processing;
    } finally {
      if (this.processing === processing) this.processing = null;
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    const jitter = Math.floor((Math.random() * 2 - 1) * SCAN_INTERVAL_JITTER_MS);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.wake();
      this.scheduleNext();
    }, Math.max(5_000, SCAN_INTERVAL_MS + jitter));
    this.timer.unref?.();
  }

  private async pass(): Promise<number> {
    try {
      await this.lapses.deleteStale();
      let handled = 0;
      for (const candidate of await this.lapses.scan()) {
        if (this.stopped || handled >= MAX_PAIRS_PER_PASS) break;
        if (lapseWork(candidate) === 'none') continue;
        if (await this.handle(candidate, SYSTEM_ACTOR)) handled += 1;
      }
      // SSH/HTTP proxies admit only covered (user, server) pairs; refresh them now.
      if (handled > 0) await this.proxySnapshots.notify('access-lapse');
      return handled;
    } catch (error) {
      this.logger.error(
        `Access lapse pass failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    }
  }

  /** Leases the pair, re-reads it, and does the one thing it is due for. */
  private async handle(scanned: LapseCandidate, actor: Actor): Promise<boolean> {
    const claim = await this.claims.claim({
      resourceType: 'access_lapse',
      resourceId: scanned.userId,
      placementServerId: scanned.resourceId,
      workerId: this.workerId,
    });
    if (!claim) return false;
    const lease = this.claims.startLeaseGuard(claim);
    try {
      const current = await this.lapses.inspect(scanned);
      if (!current) return false;
      switch (lapseWork(current)) {
        case 'clear':
          return await this.lapses.clear(current);
        case 'lapse':
          return await this.lapseAndAct(current, actor, lease.assertOwned.bind(lease));
        case 'stop':
          return await this.enforce(current, actor, lease.assertOwned.bind(lease));
        case 'purge':
          return await this.purgeResources(current, actor, lease.assertOwned.bind(lease));
        case 'detach':
          return await this.detachAfterPurge(current, actor);
        case 'none':
          return false;
      }
    } catch (error) {
      this.logger.error(
        `Access lapse ${scanned.kind} ${scanned.resourceId} of ${scanned.userId} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    } finally {
      lease.stop();
      await this.claims.release({
        resourceType: claim.resourceType,
        resourceId: claim.resourceId,
        placementServerId: claim.placementServerId,
        workerId: claim.workerId,
      }).catch((error: unknown) => {
        this.logger.warn(`Access lapse lease release failed: ${String(error)}`);
      });
    }
  }

  /** Opens the grace and acts at once when it is already due. */
  private async lapseAndAct(
    candidate: LapseCandidate,
    actor: Actor,
    assertOwned: () => void,
  ): Promise<boolean> {
    const lapse = await this.lapses.openLapse(candidate);
    if (!lapse) return false;
    assertOwned();
    const opened = { ...candidate, lapse };
    const work = lapseWork(opened);
    if (work === 'stop') return this.enforce(opened, actor, assertOwned);
    if (work === 'purge') return this.purgeResources(opened, actor, assertOwned);
    if (work === 'detach') return this.detachAfterPurge(opened, actor);
    return true;
  }

  /**
   * Server: stop the containers. Pool or backend: detach the volumes. A grant
   * committed since the scan cancels the grace instead.
   */
  private async enforce(
    candidate: LapseCandidate,
    actor: Actor,
    assertOwned: () => void,
  ): Promise<boolean> {
    if (await this.lapses.isCoveredNow(candidate)) return this.lapses.clear(candidate);
    switch (candidate.kind) {
      case 'server':
        await this.purge.stopRunningContainersForGraceEntry(
          actor,
          candidate.userId,
          candidate.resourceId,
        );
        break;
      case 'storage_pool':
      case 'shared_backend':
        await this.detachVolumes(candidate, actor);
        break;
    }
    assertOwned();
    return this.lapses.markStopped(candidate, (transaction) => this.audit.append(
      transaction,
      actor.userId,
      AuditAction.GrantExpired,
      candidate.userId,
      'user',
      {
        resourceKind: candidate.kind,
        resourceId: candidate.resourceId,
        lapsedAt: candidate.lapse?.lapsedAt.toISOString(),
      },
    ));
  }

  private async purgeResources(
    candidate: LapseCandidate,
    actor: Actor,
    assertOwned: () => void,
  ): Promise<boolean> {
    // Volumes re-attached during the grace (or whose detach failed) are
    // detached first; that is reversible and goes through its own
    // transactions, so only a lock-free look at coverage guards it.
    if (candidate.kind !== 'server' && await this.lapses.isCoveredNow(candidate)) {
      return this.lapses.clear(candidate);
    }
    if (candidate.kind !== 'server') await this.detachVolumes(candidate, actor);
    assertOwned();
    // Deleting is irreversible: every delete is queued in the transaction that
    // re-read coverage under the IAM lock, so a grant committed since the scan
    // still saves the data. The purge audit rows are written by the purge itself.
    return this.lapses.purgeIfUncovered(candidate, async (transaction) => {
      const { userId, resourceId } = candidate;
      switch (candidate.kind) {
        case 'server':
          await this.purge.purgeServerInTransaction(transaction, actor, userId, resourceId);
          break;
        case 'storage_pool':
          await this.purge.purgeStoragePoolVolumes(transaction, actor, userId, resourceId);
          break;
        case 'shared_backend':
          await this.purge.purgeSharedBackendVolumes(transaction, actor, userId, resourceId);
          break;
      }
      assertOwned();
    });
  }

  /**
   * After the purge of a pool or backend: the deleting volumes still attached
   * are detached again (`forceDetach` follows the re-drive backoff), so their
   * destroys are not left waiting on an attachment no intent will remove.
   * Reversible, so only the lock-free look at coverage guards it.
   */
  private async detachAfterPurge(candidate: LapseCandidate, actor: Actor): Promise<boolean> {
    if (await this.lapses.isCoveredNow(candidate)) return this.lapses.clear(candidate);
    const { intentIds } = await this.detachVolumes(candidate, actor);
    return intentIds.length > 0;
  }

  /** Pool or backend: detach the user's volumes there from their containers. */
  private detachVolumes(candidate: LapseCandidate, actor: Actor): Promise<{ intentIds: string[] }> {
    return candidate.kind === 'shared_backend'
      ? this.purge.detachVolumesForSharedBackend(actor, candidate.userId, candidate.resourceId)
      : this.purge.detachVolumesForStoragePool(actor, candidate.userId, candidate.resourceId);
  }
}
