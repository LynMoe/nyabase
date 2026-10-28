import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Transaction } from 'kysely';
import {
  AuditAction,
  type AuditResourceSnapshotDto,
} from '@nyabase/common';
import { NyabaseConfigService } from '../platform/config/nyabase-config.service.js';
import { MonotonicClock } from '../platform/monotonic-clock.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import {
  AuditRepository,
  RETENTION_BATCH_SIZE,
  type AuditRetentionOptions,
} from './audit.repository.js';
import {
  AuditSnapshotResolver,
  fallbackNameFromPayload,
  normalizeResourceType,
} from './audit-snapshot.resolver.js';
import { isRecord } from '../platform/domain-utils.js';
import { afterCommit } from '../platform/post-commit.js';
import { currentImpersonation } from '../platform/request-context.js';

const CLEANUP_INTERVAL_MS = 60_000;
/** Upper bound on back-to-back cleanup batches in one pass. */
const MAX_CLEANUP_BATCHES = 20;
const SENSITIVE_KEY_PATTERN =
  /(password|passwd|token|secret|private.?key|encrypted|credential|authorization|cookie)/i;

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  private nextCleanupAt = 0;
  private cleanupPromise: Promise<void> | null = null;

  constructor(
    private readonly repository: AuditRepository,
    private readonly transactions: PgTransactionManager,
    private readonly config: NyabaseConfigService,
    private readonly snapshots: AuditSnapshotResolver,
    private readonly clock: MonotonicClock,
  ) {}

  /**
   * Convenience append for post-commit callers. Snapshot reads and insertion
   * share one PostgreSQL transaction; retention runs only after it commits.
   */
  async log(
    actorId: string | null,
    action: AuditAction,
    targetId: string | null,
    targetType: string | null,
    payload?: unknown,
  ): Promise<void> {
    await this.transactions.run((transaction) => this.appendEvent(
      transaction,
      actorId,
      action,
      targetId,
      targetType,
      payload,
    ));
    await this.maybeEnforceRetention();
  }

  /**
   * Appends audit evidence in a caller-owned business transaction. Retention
   * never runs inside it: a shared cleanup lock plus `count(*)` there would
   * serialize every audited write on the platform. Cleanup is scheduled after
   * the commit and rate limited instead.
   */
  async append(
    transaction: Transaction<NyabaseDatabase>,
    actorId: string | null,
    action: AuditAction,
    targetId: string | null,
    targetType: string | null,
    payload?: unknown,
  ): Promise<void> {
    await this.appendEvent(
      transaction,
      actorId,
      action,
      targetId,
      targetType,
      payload,
    );
    afterCommit(transaction, () => {
      void this.maybeEnforceRetention();
    });
  }

  private async appendEvent(
    transaction: Transaction<NyabaseDatabase>,
    actorId: string | null,
    action: AuditAction,
    targetId: string | null,
    targetType: string | null,
    payload?: unknown,
  ): Promise<void> {
    const sanitizedPayload = sanitizeForAudit(payload ?? null);
    const relatedRefs = refsFromPayload(sanitizedPayload);
    if (targetId && targetType) {
      relatedRefs.unshift({ type: targetType, id: targetId });
    }
    // Only the impersonated user's own rows: other actors (the system, or a
    // row about someone else) were not acting for the administrator.
    const impersonation = currentImpersonation();
    const impersonatorId = actorId !== null && impersonation?.userId === actorId
      ? impersonation.impersonatorId
      : null;
    const requestedRefs = [
      ...(actorId ? [{ type: 'user', id: actorId }] : []),
      ...(impersonatorId ? [{ type: 'user', id: impersonatorId }] : []),
      ...(targetId ? [{ type: targetType, id: targetId }] : []),
      ...relatedRefs,
    ];
    const uniqueRefs = new Map<string, { type: string | null; id: string }>();
    for (const ref of requestedRefs) {
      const key = snapshotRefKey(ref.type, ref.id);
      if (!uniqueRefs.has(key)) uniqueRefs.set(key, ref);
    }
    const resolvedEntries = await Promise.all([...uniqueRefs].map(async ([key, ref]) => [
      key,
      await this.snapshots.resolve(
        transaction,
        ref.type,
        ref.id,
        sanitizedPayload,
      ),
    ] as const));
    const resolvedByRef = new Map(resolvedEntries);
    const actorSnapshot = actorId
      ? resolvedByRef.get(snapshotRefKey('user', actorId)) ?? null
      : null;
    const impersonatorSnapshot = impersonatorId
      ? resolvedByRef.get(snapshotRefKey('user', impersonatorId)) ?? null
      : null;
    const targetSnapshot = targetId
      ? resolvedByRef.get(snapshotRefKey(targetType, targetId)) ?? null
      : null;
    const related = relatedRefs.flatMap((ref) => {
      const snapshot = resolvedByRef.get(snapshotRefKey(ref.type, ref.id));
      return snapshot ? [snapshot] : [];
    }).filter((snapshot, index, snapshots) =>
      snapshots.findIndex((candidate) =>
        snapshotRefKey(candidate.type, candidate.id)
        === snapshotRefKey(snapshot.type, snapshot.id)) === index);

    await this.repository.append(transaction, {
      id: randomUUID(),
      actorId,
      actorName: actorSnapshot?.name ?? null,
      actorUsername: labelString(actorSnapshot, 'username'),
      actorSnapshot,
      impersonatorId,
      impersonatorName: impersonatorSnapshot?.name ?? null,
      impersonatorUsername: labelString(impersonatorSnapshot, 'username'),
      action,
      targetId,
      targetType,
      targetName:
        targetSnapshot?.name ?? fallbackNameFromPayload(sanitizedPayload),
      targetSnapshot,
      related,
      payload: sanitizedPayload,
    });
  }

  private async maybeEnforceRetention(): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    const retention = this.retentionRequest();
    if (!retention) return;

    this.nextCleanupAt = retention.now + CLEANUP_INTERVAL_MS;
    this.cleanupPromise = this.drainRetention(retention.options)
      .catch((error: unknown) => {
        this.logger.warn(
          `Audit retention cleanup failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      })
      .finally(() => {
        this.cleanupPromise = null;
      });
    await this.cleanupPromise;
  }

  private async drainRetention(options: AuditRetentionOptions): Promise<void> {
    for (let batch = 0; batch < MAX_CLEANUP_BATCHES; batch += 1) {
      const deleted = await this.repository.enforceRetention(options);
      if (deleted < RETENTION_BATCH_SIZE) return;
    }
  }

  private retentionRequest(): {
    now: number;
    options: AuditRetentionOptions;
  } | null {
    const retentionDays = this.config.get<number>('audit.retentionDays');
    const maxEntries = this.config.get<number>('audit.retentionMaxEntries');
    const now = this.clock.now();
    if (now < this.nextCleanupAt) return null;
    const enforceAge = retentionDays > 0;
    const enforceCount = maxEntries > 0;
    if (!enforceAge && !enforceCount) return null;
    return {
      now,
      options: {
        retentionDays,
        maxEntries,
        enforceAge,
        enforceCount,
      },
    };
  }

}

export function sanitizeForAudit(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[MaxDepth]';
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForAudit(item, depth + 1));
  }
  if (!isRecord(value)) return value;

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? '[REDACTED]'
      : sanitizeForAudit(child, depth + 1);
  }
  return output;
}

function labelString(
  snapshot: AuditResourceSnapshotDto | null,
  key: string,
): string | null {
  const value = snapshot?.labels?.[key];
  return value === undefined || value === null ? null : String(value);
}

function refsFromPayload(
  payload: unknown,
): Array<{ type: string; id: string }> {
  if (!isRecord(payload)) return [];
  const refs: Array<{ type: string; id: string }> = [];
  const mappings: Array<[string, string]> = [
    ['userId', 'user'],
    ['actorId', 'user'],
    ['ownerId', 'user'],
    ['createdBy', 'user'],
    ['bundleId', 'grant_bundle'],
    ['serverId', 'server'],
    ['imageId', 'image'],
    ['containerId', 'container'],
    ['poolId', 'storage_pool'],
    ['sharedBackendId', 'shared_backend'],
    ['volumeId', 'volume'],
  ];
  for (const [key, type] of mappings) {
    const id = stringValue(payload[key]);
    if (id) refs.push({ type, id });
  }

  return refs;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function snapshotRefKey(type: string | null, id: string | null): string {
  return `${normalizeResourceType(type) ?? type ?? ''}:${id}`;
}
