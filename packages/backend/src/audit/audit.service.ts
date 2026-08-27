import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Transaction } from 'kysely';
import {
  AuditAction,
  type AuditResourceSnapshotDto,
} from '@nyabase/common';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import {
  AuditRepository,
  type AuditRetentionOptions,
} from './audit.repository.js';
import {
  AUDIT_SNAPSHOT_RESOLVER,
  fallbackNameFromPayload,
  normalizeResourceType,
  type AuditSnapshotResolver,
} from './audit-snapshot.resolver.js';

const CLEANUP_INTERVAL_MS = 60_000;
const SENSITIVE_KEY_PATTERN =
  /(password|passwd|token|secret|private.?key|encrypted|credential|authorization|cookie)/i;
export const AUDIT_MONOTONIC_CLOCK = Symbol('AUDIT_MONOTONIC_CLOCK');

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  private nextCleanupAt = 0;
  private cleanupPromise: Promise<void> | null = null;

  constructor(
    private readonly repository: AuditRepository,
    private readonly transactions: PgTransactionManager,
    private readonly config: NyabaseConfigService,
    @Inject(AUDIT_SNAPSHOT_RESOLVER)
    private readonly snapshots: AuditSnapshotResolver,
    @Optional()
    @Inject(AUDIT_MONOTONIC_CLOCK)
    private readonly monotonicNow?: () => number,
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
   * Appends audit evidence and enforces retention in a caller-owned business
   * transaction. A rollback removes the domain mutation, event, and cleanup.
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
    await this.maybeEnforceRetentionInTransaction(transaction);
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
    const requestedRefs = [
      ...(actorId ? [{ type: 'user', id: actorId }] : []),
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

  private async maybeEnforceRetentionInTransaction(
    transaction: Transaction<NyabaseDatabase>,
  ): Promise<void> {
    // The caller may roll back after append(), so do not advance shared
    // cooldown state from work that is not known to have committed.
    const retention = this.retentionRequest(true);
    if (!retention) return;
    await this.repository.enforceRetentionInTransaction(
      transaction,
      retention.options,
    );
  }

  private async maybeEnforceRetention(): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    const retention = this.retentionRequest();
    if (!retention) return;

    this.cleanupPromise = this.repository.enforceRetention(retention.options)
      .then(() => {
        if (retention.options.enforceAge) {
          this.nextCleanupAt = retention.now + CLEANUP_INTERVAL_MS;
        }
      })
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

  private retentionRequest(forceAge = false): {
    now: number;
    options: AuditRetentionOptions;
  } | null {
    const retentionDays = this.config.get<number>('audit.retentionDays');
    const maxEntries = this.config.get<number>('audit.retentionMaxEntries');
    const now = this.monotonicNow?.() ?? performance.now();
    const enforceAge = retentionDays > 0
      && (forceAge || now >= this.nextCleanupAt);
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
    ['groupId', 'group'],
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function snapshotRefKey(type: string | null, id: string | null): string {
  return `${normalizeResourceType(type) ?? type ?? ''}:${id}`;
}
