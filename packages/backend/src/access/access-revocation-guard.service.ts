import { ConflictException, Injectable } from '@nestjs/common';
import { GRANT_EXPIRY_GRACE_DAYS } from '@nyabase/common';
import { sql } from 'kysely';
import type { IamTransaction } from './access-resolver.service.js';

export interface UserServerAccess {
  userId: string;
  serverId: string;
}

export interface ExactMountSource {
  sourceKind: 'local' | 'remote';
  sourceId: string;
  serverId: string | null;
  sourceIdentity: string | null;
}

function transactionFrom(value: unknown): IamTransaction {
  if (
    !value
    || typeof value !== 'object'
    || typeof (value as { selectFrom?: unknown }).selectFrom !== 'function'
  ) throw new Error('Access revocation guard requires a PostgreSQL/Kysely transaction');
  return value as IamTransaction;
}

@Injectable()
export class AccessRevocationGuardService {
  async assertServerAccessRevocationSafe(
    executor: unknown,
    affected: readonly UserServerAccess[],
  ): Promise<void> {
    const transaction = transactionFrom(executor);
    const unique = [...new Map(affected.map((entry) => [
      `${entry.userId}\0${entry.serverId}`,
      entry,
    ])).values()];
    if (unique.length === 0) return;
    const conflicts = await sql<{
      user_id: string;
      server_id: string;
      dependency_kind: string;
      dependency_id: string;
    }>`
      WITH affected AS (
        SELECT
          (entry.value ->> 'userId')::uuid AS user_id,
          entry.value ->> 'serverId' AS server_id,
          entry.ordinality
        FROM jsonb_array_elements(${JSON.stringify(unique)}::jsonb)
          WITH ORDINALITY AS entry(value, ordinality)
      ),
      revoked AS (
        SELECT affected.*
        FROM affected
        WHERE NOT EXISTS (
          SELECT 1
          FROM iam.server_grants AS direct_grant
          WHERE direct_grant.user_id = affected.user_id
            AND direct_grant.server_id = affected.server_id
            AND (
              direct_grant.expires_at IS NULL
              OR direct_grant.expires_at + make_interval(days => ${GRANT_EXPIRY_GRACE_DAYS})
                > clock_timestamp()
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM iam.group_members AS membership
          INNER JOIN iam.server_grants AS inherited_grant
            ON inherited_grant.group_id = membership.group_id
          WHERE membership.user_id = affected.user_id
            AND inherited_grant.server_id = affected.server_id
            AND (
              inherited_grant.expires_at IS NULL
              OR inherited_grant.expires_at + make_interval(days => ${GRANT_EXPIRY_GRACE_DAYS})
                > clock_timestamp()
            )
        )
      )
      SELECT
        revoked.user_id::text AS user_id,
        revoked.server_id,
        dependency.dependency_kind,
        dependency.dependency_id
      FROM revoked
      CROSS JOIN LATERAL (
        SELECT candidate.dependency_kind, candidate.dependency_id
        FROM control.authorization_dependencies AS candidate
        WHERE candidate.user_id = revoked.user_id
          AND candidate.server_id = revoked.server_id
          AND (
            candidate.dependency_kind = 'container'
            OR (
              candidate.dependency_kind = 'data_directory'
              AND candidate.source_kind = 'local'
            )
          )
        ORDER BY candidate.created_at, candidate.id
        LIMIT 1
      ) AS dependency
      ORDER BY revoked.ordinality
      LIMIT 1
    `.execute(transaction);
    const conflict = conflicts.rows[0];
    if (!conflict) return;
    throw new ConflictException({
      code: 'ACCESS_REVOKE_HAS_RESOURCES',
      message: `User ${conflict.user_id} still owns local resources on server ${conflict.server_id}`,
      userId: conflict.user_id,
      serverId: conflict.server_id,
      dependencyKind: conflict.dependency_kind,
      dependencyId: conflict.dependency_id,
    });
  }

  async assertMountSourceRevocationSafe(
    executor: unknown,
    userIds: readonly string[],
    source: ExactMountSource,
  ): Promise<void> {
    return this.assertMountSourcesRevocationSafe(executor, userIds, [source]);
  }

  async assertMountSourcesRevocationSafe(
    executor: unknown,
    userIds: readonly string[],
    sources: readonly ExactMountSource[],
  ): Promise<void> {
    const transaction = transactionFrom(executor);
    const uniqueUsers = [...new Set(userIds)];
    const uniqueSources = [...new Map(sources.map((source) => [
      [
        source.sourceKind,
        source.sourceId,
        source.serverId ?? '',
        source.sourceIdentity ?? '',
      ].join('\0'),
      source,
    ])).values()];
    if (uniqueUsers.length === 0 || uniqueSources.length === 0) return;
    const conflicts = await sql<{
      user_id: string;
      source_kind: ExactMountSource['sourceKind'];
      source_id: string;
      server_id: string | null;
      source_identity: string | null;
      dependency_kind: string;
      dependency_id: string;
    }>`
      WITH affected_users AS (
        SELECT
          (entry.value #>> '{}')::uuid AS user_id,
          entry.ordinality AS user_ordinality
        FROM jsonb_array_elements(${JSON.stringify(uniqueUsers)}::jsonb)
          WITH ORDINALITY AS entry(value, ordinality)
      ),
      affected_sources AS (
        SELECT
          entry.value ->> 'sourceKind' AS source_kind,
          entry.value ->> 'sourceId' AS source_id,
          entry.value ->> 'serverId' AS server_id,
          entry.value ->> 'sourceIdentity' AS source_identity,
          entry.ordinality AS source_ordinality
        FROM jsonb_array_elements(${JSON.stringify(uniqueSources)}::jsonb)
          WITH ORDINALITY AS entry(value, ordinality)
      ),
      affected AS (
        SELECT affected_users.*, affected_sources.*
        FROM affected_users
        CROSS JOIN affected_sources
      ),
      revoked AS (
        SELECT affected.*
        FROM affected
        WHERE NOT EXISTS (
          SELECT 1
          FROM iam.mount_source_grants AS direct_grant
          WHERE direct_grant.user_id = affected.user_id
            AND direct_grant.source_kind = affected.source_kind
            AND direct_grant.source_id = affected.source_id
            AND (
              affected.source_kind = 'remote'
              OR (
                direct_grant.server_id = affected.server_id
                AND direct_grant.source_identity = affected.source_identity
              )
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM iam.group_members AS membership
          INNER JOIN iam.mount_source_grants AS inherited_grant
            ON inherited_grant.group_id = membership.group_id
          WHERE membership.user_id = affected.user_id
            AND inherited_grant.source_kind = affected.source_kind
            AND inherited_grant.source_id = affected.source_id
            AND (
              affected.source_kind = 'remote'
              OR (
                inherited_grant.server_id = affected.server_id
                AND inherited_grant.source_identity = affected.source_identity
              )
            )
        )
      )
      SELECT
        revoked.user_id::text AS user_id,
        revoked.source_kind,
        revoked.source_id,
        revoked.server_id,
        revoked.source_identity,
        dependency.dependency_kind,
        dependency.dependency_id
      FROM revoked
      CROSS JOIN LATERAL (
        SELECT candidate.dependency_kind, candidate.dependency_id
        FROM control.authorization_dependencies AS candidate
        WHERE candidate.user_id = revoked.user_id
          AND candidate.source_kind = revoked.source_kind
          AND candidate.source_id = revoked.source_id
          AND (
            revoked.source_kind = 'remote'
            OR (
              candidate.server_id = revoked.server_id
              AND candidate.source_identity = revoked.source_identity
            )
          )
        ORDER BY candidate.created_at, candidate.id
        LIMIT 1
      ) AS dependency
      ORDER BY revoked.source_ordinality, revoked.user_ordinality
      LIMIT 1
    `.execute(transaction);
    const conflict = conflicts.rows[0];
    if (!conflict) return;
    const exactSource: ExactMountSource = {
      sourceKind: conflict.source_kind,
      sourceId: conflict.source_id,
      serverId: conflict.server_id,
      sourceIdentity: conflict.source_identity,
    };
    throw new ConflictException({
      code: 'ACCESS_REVOKE_HAS_RESOURCES',
      message: `User ${conflict.user_id} still owns resources on mount source ${conflict.source_id}`,
      userId: conflict.user_id,
      ...exactSource,
      dependencyKind: conflict.dependency_kind,
      dependencyId: conflict.dependency_id,
    });
  }
}
