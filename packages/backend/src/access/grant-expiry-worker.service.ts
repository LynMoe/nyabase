import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { AuditAction } from '@nyabase/common';
import { AuditService } from '../audit/audit.service.js';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import {
  classifyGrantExpiry,
  expiresAtSortKey,
  selectWinningGrantCandidate,
  type GrantExpiryCandidate,
} from './grant-expiry.js';
import {
  GrantExpiryEnforcementRepository,
} from './grant-expiry-enforcement.repository.js';
import { UserServerResourcePurgeService } from './user-server-resource-purge.service.js';
import { RuntimeRoleService } from '../runtime/runtime-role.service.js';
import { SYSTEM_ACTOR_USERNAME } from '../groups/groups.service.js';

const EXPIRY_INTERVAL_MS = 60_000;
const EXPIRY_INTERVAL_JITTER_MS = 15_000;
const MAX_PAIRS_PER_PASS = 128;

interface CoveringGrantRow {
  user_id: string;
  server_id: string;
  scope_rank: number;
  priority: number;
  tie_breaker: string;
  expires_at: Date | null;
  cpu_millis: number | null;
  mem_bytes: string | null;
  disk_bytes: string | null;
  extension_grants: unknown;
}

interface ExpiryPair {
  userId: string;
  serverId: string;
  phase: 'grace' | 'lost';
  coveringExpiresAt: Date;
  needsWork: boolean;
}

type ResourceGrantKind = 'storage_pool' | 'shared_backend';

interface ResourceGrantCandidate {
  userId: string;
  resourceId: string;
  kind: ResourceGrantKind;
  scopeRank: number;
  priority: number;
  tieBreaker: string;
  expiresAt: Date | string | null;
}

interface ResourceExpiryPair {
  userId: string;
  resourceId: string;
  kind: ResourceGrantKind;
  phase: 'grace' | 'lost';
  coveringExpiresAt: Date;
  needsWork: boolean;
}

/**
 * Periodically enforces grant expiry:
 * - grace entry: lease-claimed one-shot stop + GrantExpired audit
 * - lost server grants: lease-claimed purge of local containers and volumes
 * - shared-backend/pool grace grants: lease per-container stop intents using retained volumes
 * - lost shared-backend/pool grants: idempotent desired-state volume cleanup
 *
 * Multi-replica safety comes from PostgreSQL claim_token leases, not from
 * single-process assumptions.
 */
@Injectable()
export class GrantExpiryWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GrantExpiryWorkerService.name);
  private readonly workerId = `grant-expiry:${randomUUID()}`;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private wakeTimer: ReturnType<typeof setImmediate> | null = null;
  private processing: Promise<void> | null = null;
  private stopped = false;

  constructor(
    @Inject(PG_DATABASE)
    private readonly database: Kysely<NyabaseDatabase>,
    private readonly transactions: PgTransactionManager,
    private readonly runtimeRole: RuntimeRoleService,
    private readonly enforcement: GrantExpiryEnforcementRepository,
    private readonly purge: UserServerResourcePurgeService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    if (!this.runtimeRole.runsWorker()) return;
    this.stopped = false;
    this.scheduleNext();
    this.wake();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.wakeTimer) clearImmediate(this.wakeTimer);
    this.timer = null;
    this.wakeTimer = null;
    await this.processing;
  }

  wake(): void {
    if (this.stopped || !this.runtimeRole.runsWorker() || this.wakeTimer) return;
    this.wakeTimer = setImmediate(() => {
      this.wakeTimer = null;
      if (!this.stopped) void this.process();
    });
  }

  async process(): Promise<void> {
    if (this.stopped || !this.runtimeRole.runsWorker()) return;
    if (this.processing) return this.processing;
    const processing = this.processPass();
    this.processing = processing;
    try {
      await processing;
    } finally {
      if (this.processing === processing) this.processing = null;
    }
  }

  private scheduleNext(): void {
    if (this.stopped || !this.runtimeRole.runsWorker()) return;
    if (this.timer) clearTimeout(this.timer);
    const jitter = Math.floor(
      (Math.random() * 2 - 1) * EXPIRY_INTERVAL_JITTER_MS,
    );
    const delay = Math.max(5_000, EXPIRY_INTERVAL_MS + jitter);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.wake();
      this.scheduleNext();
    }, delay);
    this.timer.unref?.();
  }

  private async processPass(): Promise<void> {
    try {
      const systemActorId = await this.resolveSystemActorId();
      if (!systemActorId) {
        this.logger.warn(
          'Grant expiry worker skipped: nyabase-system actor is missing',
        );
        return;
      }
      const phases = await this.scanAccessPhases();
      let handled = 0;
      for (const pair of phases) {
        if (this.stopped || handled >= MAX_PAIRS_PER_PASS) break;
        if (!pair.needsWork) continue;
        if (pair.phase === 'grace') {
          const didWork = await this.enforceGraceStop(
            pair.userId,
            pair.serverId,
            pair.coveringExpiresAt,
            systemActorId,
          );
          if (didWork) handled += 1;
        } else if (pair.phase === 'lost') {
          const didWork = await this.enforceLostPurge(
            pair.userId,
            pair.serverId,
            pair.coveringExpiresAt,
            systemActorId,
          );
          if (didWork) handled += 1;
        }
      }
      const resourcePhases = await this.scanResourceGrantPhases();
      for (const pair of resourcePhases) {
        if (this.stopped || handled >= MAX_PAIRS_PER_PASS) break;
        if (!pair.needsWork) continue;
        const didWork = pair.phase === 'grace'
          ? await this.enforceResourceGraceStop(pair, systemActorId)
          : await this.enforceResourceLostPurge(pair, systemActorId);
        if (didWork) handled += 1;
      }
    } catch (error) {
      this.logger.error(
        `Grant expiry worker pass failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async resolveSystemActorId(): Promise<string | null> {
    const row = await this.database.selectFrom('iam.users as user')
      .select('user.id')
      .where('user.username', '=', SYSTEM_ACTOR_USERNAME)
      .executeTakeFirst();
    return row?.id ?? null;
  }

  private async scanAccessPhases(): Promise<ExpiryPair[]> {
    const result = await sql<CoveringGrantRow>`
      SELECT
        direct_grant.user_id::text AS user_id,
        direct_grant.server_id,
        0 AS scope_rank,
        0 AS priority,
        direct_grant.id::text AS tie_breaker,
        direct_grant.expires_at,
        direct_grant.cpu_millis,
        direct_grant.mem_bytes,
        direct_grant.disk_bytes,
        direct_grant.extension_grants
      FROM iam.server_grants AS direct_grant
      WHERE direct_grant.user_id IS NOT NULL
      UNION ALL
      SELECT
        membership.user_id::text AS user_id,
        inherited_grant.server_id,
        1 AS scope_rank,
        inherited_group.priority,
        inherited_group.id::text AS tie_breaker,
        inherited_grant.expires_at,
        inherited_grant.cpu_millis,
        inherited_grant.mem_bytes,
        inherited_grant.disk_bytes,
        inherited_grant.extension_grants
      FROM iam.group_members AS membership
      INNER JOIN iam.groups AS inherited_group
        ON inherited_group.id = membership.group_id
      INNER JOIN iam.server_grants AS inherited_grant
        ON inherited_grant.group_id = membership.group_id
    `.execute(this.database);

    const byPair = new Map<string, Array<GrantExpiryCandidate & CoveringGrantRow>>();
    for (const row of result.rows) {
      const key = `${row.user_id}\0${row.server_id}`;
      const list = byPair.get(key) ?? [];
      list.push({
        ...row,
        scopeRank: row.scope_rank,
        priority: row.priority,
        tieBreaker: row.tie_breaker,
        expiresAt: row.expires_at,
      });
      byPair.set(key, list);
    }

    const now = new Date();
    const draft: Array<Omit<ExpiryPair, 'needsWork'> & { phase: 'grace' | 'lost' }> = [];
    for (const [key, candidates] of byPair) {
      const [userId, serverId] = key.split('\0') as [string, string];
      const winner = selectWinningGrantCandidate(candidates, now);
      if (winner?.phase === 'grace') {
        const coveringExpiresAt = asCoveringExpiresAt(winner.candidate.expiresAt);
        if (!coveringExpiresAt) continue;
        draft.push({ userId, serverId, phase: 'grace', coveringExpiresAt });
        continue;
      }
      if (winner) continue;

      const lostCandidates = candidates.filter(
        (candidate) => classifyGrantExpiry(candidate.expiresAt, now) === 'lost',
      );
      if (lostCandidates.length === 0) continue;
      const coveringExpiresAt = latestCoveringExpiresAt(lostCandidates);
      if (!coveringExpiresAt) continue;
      draft.push({ userId, serverId, phase: 'lost', coveringExpiresAt });
    }

    if (draft.length === 0) return [];

    const enforcementRows = await this.database
      .selectFrom('control.grant_expiry_enforcement')
      .selectAll()
      .where((expression) => expression.or(
        draft.map((pair) => expression.and([
          expression('user_id', '=', pair.userId),
          expression('server_id', '=', pair.serverId),
          expression('covering_expires_at', '=', pair.coveringExpiresAt),
        ])),
      ))
      .execute();
    const enforcementByKey = new Map(
      enforcementRows.map((row) => [
        enforcementKey(row.user_id, row.server_id, row.covering_expires_at),
        row,
      ]),
    );

    const localResourcePairs = draft.filter((pair) => pair.phase === 'lost');
    const localResourceKeys = new Set<string>();
    if (localResourcePairs.length > 0) {
      const localDeps = await this.database
        .selectFrom('control.authorization_dependencies')
        .select(['user_id', 'server_id'])
        .where((expression) => expression.or(
          localResourcePairs.map((pair) => expression.and([
            expression('user_id', '=', pair.userId),
            expression('server_id', '=', pair.serverId),
          ])),
        ))
        .where('dependency_kind', 'in', ['container', 'volume', 'volume_attachment'])
        .execute();
      for (const row of localDeps) {
        localResourceKeys.add(`${row.user_id}\0${row.server_id}`);
      }
    }

    const out: ExpiryPair[] = [];
    for (const pair of draft) {
      const row = enforcementByKey.get(
        enforcementKey(pair.userId, pair.serverId, pair.coveringExpiresAt),
      );
      if (pair.phase === 'grace') {
        out.push({
          ...pair,
          needsWork: GrantExpiryEnforcementRepository.isDueForWork('grace', row, now),
        });
        continue;
      }
      if (row?.purged_at != null) continue;
      const remaining = localResourceKeys.has(`${pair.userId}\0${pair.serverId}`);
      const due = GrantExpiryEnforcementRepository.isDueForWork('lost', row, now);
      out.push({
        ...pair,
        // Finish empty lost only when a prior claim exists (crash after deletes).
        needsWork: due && (remaining || row?.claim_token != null),
      });
    }

    out.sort((left, right) => {
      if (left.needsWork !== right.needsWork) return left.needsWork ? -1 : 1;
      if (left.phase !== right.phase) return left.phase === 'grace' ? -1 : 1;
      return left.coveringExpiresAt.getTime() - right.coveringExpiresAt.getTime();
    });
    return out;
  }

  private async enforceGraceStop(
    userId: string,
    serverId: string,
    coveringExpiresAt: Date,
    actorId: string,
  ): Promise<boolean> {
    const claim = await this.enforcement.claim(
      'grace',
      userId,
      serverId,
      coveringExpiresAt,
      this.workerId,
    );
    if (!claim) return false;
    try {
      await this.purge.stopRunningContainersForGraceEntry(userId, serverId, actorId);
      const completed = await this.transactions.run(async (transaction) => {
        const won = await this.enforcement.completeGraceInTransaction(transaction, claim);
        if (!won) return false;
        await this.audit.append(
          transaction,
          actorId,
          AuditAction.GrantExpired,
          userId,
          'user',
          { serverId },
        );
        return true;
      });
      return completed;
    } catch (error) {
      this.logger.error(
        `Grace stop failed for ${userId}/${serverId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await this.enforcement.release(claim).catch((releaseError) => {
        this.logger.warn(
          `Grace stop lease release failed for ${userId}/${serverId}: ${
            releaseError instanceof Error ? releaseError.message : String(releaseError)
          }`,
        );
      });
      return false;
    }
  }

  private async enforceLostPurge(
    userId: string,
    serverId: string,
    coveringExpiresAt: Date,
    actorId: string,
  ): Promise<boolean> {
    const claim = await this.enforcement.claim(
      'lost',
      userId,
      serverId,
      coveringExpiresAt,
      this.workerId,
    );
    if (!claim) return false;
    try {
      const remaining = await this.hasLocalRuntimeResources(userId, serverId);
      if (remaining) {
        await this.purge.purge(userId, serverId, actorId, 'expiry');
      }
      if (await this.hasLocalRuntimeResources(userId, serverId)) {
        return false;
      }
      const completed = await this.enforcement.completeLost(claim);
      return completed;
    } catch (error) {
      this.logger.error(
        `Lost purge failed for ${userId}/${serverId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await this.enforcement.release(claim).catch((releaseError) => {
        this.logger.warn(
          `Lost purge lease release failed for ${userId}/${serverId}: ${
            releaseError instanceof Error ? releaseError.message : String(releaseError)
          }`,
        );
      });
      return false;
    }
  }

  private async scanResourceGrantPhases(): Promise<ResourceExpiryPair[]> {
    const [poolRows, backendRows] = await Promise.all([
      this.database.selectFrom('iam.storage_pool_grants as grant')
        .leftJoin('iam.group_members as member', 'member.group_id', 'grant.group_id')
        .leftJoin('iam.groups as group', 'group.id', 'grant.group_id')
        .select([
          'grant.user_id',
          'member.user_id as member_user_id',
          'grant.pool_id as resource_id',
          'grant.expires_at',
          'grant.id',
          'group.priority',
        ])
        .execute(),
      this.database.selectFrom('iam.shared_backend_grants as grant')
        .leftJoin('iam.group_members as member', 'member.group_id', 'grant.group_id')
        .leftJoin('iam.groups as group', 'group.id', 'grant.group_id')
        .select([
          'grant.user_id',
          'member.user_id as member_user_id',
          'grant.shared_backend_id as resource_id',
          'grant.expires_at',
          'grant.id',
          'group.priority',
        ])
        .execute(),
    ]);
    const candidates: ResourceGrantCandidate[] = [
      ...poolRows.flatMap((row) => row.user_id || row.member_user_id
        ? [{
          userId: row.user_id ?? row.member_user_id!,
          resourceId: row.resource_id,
          kind: 'storage_pool' as const,
          scopeRank: row.user_id ? 0 : 1,
          priority: row.priority ?? 0,
          tieBreaker: row.id,
          expiresAt: row.expires_at,
        }]
        : []),
      ...backendRows.flatMap((row) => row.user_id || row.member_user_id
        ? [{
          userId: row.user_id ?? row.member_user_id!,
          resourceId: row.resource_id,
          kind: 'shared_backend' as const,
          scopeRank: row.user_id ? 0 : 1,
          priority: row.priority ?? 0,
          tieBreaker: row.id,
          expiresAt: row.expires_at,
        }]
        : []),
    ];
    const byResource = new Map<string, ResourceGrantCandidate[]>();
    for (const candidate of candidates) {
      const key = `${candidate.kind}\0${candidate.userId}\0${candidate.resourceId}`;
      const list = byResource.get(key) ?? [];
      list.push(candidate);
      byResource.set(key, list);
    }
    const now = new Date();
    const result: ResourceExpiryPair[] = [];
    for (const [key, resourceCandidates] of byResource) {
      const [kind, userId, resourceId] = key.split('\0') as [
        ResourceGrantKind,
        string,
        string,
      ];
      const winning = selectWinningResourceGrant(resourceCandidates, now);
      const lostCandidates = resourceCandidates.filter(
        (candidate) => classifyGrantExpiry(candidate.expiresAt, now) === 'lost',
      );
      if (winning) {
        if (classifyGrantExpiry(winning.expiresAt, now) !== 'grace') continue;
        const coveringExpiresAt = asCoveringExpiresAt(winning.expiresAt);
        if (!coveringExpiresAt || !await this.hasResourceVolumes(userId, kind, resourceId)) continue;
        result.push({
          userId,
          resourceId,
          kind,
          phase: 'grace',
          coveringExpiresAt,
          needsWork: true,
        });
        continue;
      }
      if (lostCandidates.length === 0) continue;
      const coveringExpiresAt = latestCoveringExpiresAt(lostCandidates);
      if (!coveringExpiresAt) continue;
      if (!await this.hasResourceVolumes(userId, kind, resourceId)) continue;
      result.push({
        userId,
        resourceId,
        kind,
        phase: 'lost',
        coveringExpiresAt,
        needsWork: true,
      });
    }
    result.sort((left, right) =>
      left.coveringExpiresAt.getTime() - right.coveringExpiresAt.getTime());
    return result;
  }

  private async hasResourceVolumes(
    userId: string,
    kind: ResourceGrantKind,
    resourceId: string,
  ): Promise<boolean> {
    let query = this.database.selectFrom('control.volumes')
      .select('id')
      .where('owner_id', '=', userId);
    query = kind === 'storage_pool'
      ? query.where('pool_id', '=', resourceId).where('shared_backend_id', 'is', null)
      : query.where('shared_backend_id', '=', resourceId);
    return Boolean(await query.executeTakeFirst());
  }

  private async enforceResourceLostPurge(
    pair: ResourceExpiryPair,
    actorId: string,
  ): Promise<boolean> {
    const result = pair.kind === 'storage_pool'
      ? await this.purge.purgeStoragePoolVolumes(pair.userId, pair.resourceId, actorId)
      : await this.purge.purgeSharedBackendVolumes(pair.userId, pair.resourceId, actorId);
    return result.volumeIds.length > 0;
  }

  private async enforceResourceGraceStop(
    pair: ResourceExpiryPair,
    actorId: string,
  ): Promise<boolean> {
    const result = pair.kind === 'storage_pool'
      ? await this.purge.stopRunningContainersForStoragePool(
        pair.userId,
        pair.resourceId,
        actorId,
        this.workerId,
      )
      : await this.purge.stopRunningContainersForSharedBackend(
        pair.userId,
        pair.resourceId,
        actorId,
        this.workerId,
      );
    return result.intentIds.length > 0;
  }

  private async hasLocalRuntimeResources(
    userId: string,
    serverId: string,
  ): Promise<boolean> {
    const dependency = await this.database
      .selectFrom('control.authorization_dependencies')
      .select('id')
      .where('user_id', '=', userId)
      .where('server_id', '=', serverId)
      .where('dependency_kind', 'in', ['container', 'volume', 'volume_attachment'])
      .executeTakeFirst();
    return Boolean(dependency);
  }
}

function selectWinningResourceGrant(
  candidates: readonly ResourceGrantCandidate[],
  now: Date,
): ResourceGrantCandidate | null {
  const live = candidates.filter((candidate) => classifyGrantExpiry(candidate.expiresAt, now) === 'live');
  const grace = candidates.filter((candidate) => classifyGrantExpiry(candidate.expiresAt, now) === 'grace');
  const pool = live.length > 0 ? live : grace;
  if (pool.length === 0) return null;
  return [...pool].sort((left, right) => {
    if (left.scopeRank !== right.scopeRank) return left.scopeRank - right.scopeRank;
    const leftExpires = expiresAtSortKey(left.expiresAt);
    const rightExpires = expiresAtSortKey(right.expiresAt);
    if (leftExpires !== rightExpires) return rightExpires > leftExpires ? 1 : -1;
    if (left.priority !== right.priority) return right.priority - left.priority;
    return right.tieBreaker.localeCompare(left.tieBreaker);
  })[0] ?? null;
}

function enforcementKey(
  userId: string,
  serverId: string,
  coveringExpiresAt: Date,
): string {
  return `${userId}\0${serverId}\0${coveringExpiresAt.toISOString()}`;
}

function asCoveringExpiresAt(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function latestCoveringExpiresAt(
  candidates: readonly { expiresAt: Date | string | null }[],
): Date | null {
  let best: Date | null = null;
  let bestKey = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    const date = asCoveringExpiresAt(candidate.expiresAt);
    if (!date) continue;
    const key = expiresAtSortKey(date);
    if (!Number.isFinite(key)) continue;
    if (key >= bestKey) {
      bestKey = key;
      best = date;
    }
  }
  return best;
}
