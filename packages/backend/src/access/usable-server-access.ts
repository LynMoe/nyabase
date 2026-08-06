import { sql, type Transaction } from 'kysely';
import { GRANT_EXPIRY_GRACE_DAYS } from '@nyabase/common';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';

/**
 * Returns `${userId}\0${serverId}` keys for pairs that still have live or grace
 * server access (dead grants are excluded).
 */
export async function loadUsableServerAccessKeys(
  transaction: Transaction<NyabaseDatabase>,
): Promise<Set<string>> {
  const result = await sql<{ user_id: string; server_id: string }>`
    SELECT DISTINCT access.user_id::text AS user_id, access.server_id
    FROM (
      SELECT direct_grant.user_id, direct_grant.server_id
      FROM iam.server_grants AS direct_grant
      WHERE direct_grant.user_id IS NOT NULL
        AND (
          direct_grant.expires_at IS NULL
          OR direct_grant.expires_at
            + make_interval(days => ${GRANT_EXPIRY_GRACE_DAYS})
            > clock_timestamp()
        )
      UNION ALL
      SELECT membership.user_id, inherited_grant.server_id
      FROM iam.group_members AS membership
      INNER JOIN iam.server_grants AS inherited_grant
        ON inherited_grant.group_id = membership.group_id
      WHERE inherited_grant.group_id IS NOT NULL
        AND (
          inherited_grant.expires_at IS NULL
          OR inherited_grant.expires_at
            + make_interval(days => ${GRANT_EXPIRY_GRACE_DAYS})
            > clock_timestamp()
        )
    ) AS access
  `.execute(transaction);
  return new Set(result.rows.map((row) => `${row.user_id}\0${row.server_id}`));
}
