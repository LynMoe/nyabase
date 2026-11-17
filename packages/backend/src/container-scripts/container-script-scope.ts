import { sql, type RawBuilder } from 'kysely';

/**
 * Whether the container aliased `container` is in the scope of the version
 * row aliased `version`: the SQL form of common `containerScriptScopeMatches`.
 * The version table's CHECK guarantees a scope that is not `all` names at
 * least one list, so an empty filter never matches everything.
 */
export function scopeMatchSql(version: string, container: string): RawBuilder<boolean> {
  const v = (column: string) => sql.ref(`${version}.${column}`);
  const c = (column: string) => sql.ref(`${container}.${column}`);
  return sql<boolean>`(
    NOT (${c('id')} = ANY(${v('scope_exclude_container_ids')}))
    AND (
      ${v('scope_all')}
      OR (
        (cardinality(${v('scope_server_ids')}) = 0 OR ${c('server_id')} = ANY(${v('scope_server_ids')}))
        AND (cardinality(${v('scope_image_ids')}) = 0 OR ${c('image_id')} = ANY(${v('scope_image_ids')}))
        AND (cardinality(${v('scope_owner_ids')}) = 0 OR ${c('owner_id')} = ANY(${v('scope_owner_ids')}))
        AND (cardinality(${v('scope_container_ids')}) = 0 OR ${c('id')} = ANY(${v('scope_container_ids')}))
      )
    )
  )`;
}

/**
 * Where a pending target really stands: `waiting` while its container is not
 * running (desired and observed), else as stored. Aliases: target, container,
 * observation (left-joined).
 */
export function derivedStateSql(target: string, container: string, observation: string): RawBuilder<string> {
  return sql<string>`CASE
    WHEN ${sql.ref(`${target}.state`)} = 'pending' AND NOT (
      ${sql.ref(`${container}.lifecycle_phase`)} = 'active'
      AND ${sql.ref(`${container}.power_intent`)} = 'running'
      AND coalesce(${sql.ref(`${observation}.instance_status`)}, '') = 'running'
    ) THEN 'waiting'
    ELSE ${sql.ref(`${target}.state`)}
  END`;
}
