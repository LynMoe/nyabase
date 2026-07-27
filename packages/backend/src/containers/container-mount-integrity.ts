import {
  MAX_CONTAINER_MOUNTS,
  remoteFsSourceIdentity,
  type RemoteFsParams,
} from '@nyabase/common';
import { sql, type Transaction } from 'kysely';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import type {
  ContainerAggregate,
  ContainerMountRecord,
} from './container-control.repository.js';
import {
  normalizeContainerMounts,
  type NormalizedContainerMount,
} from './container-mount-normalizer.js';

export type ContainerMountIntegrityFailureKind =
  | 'desired_invalid'
  | 'index_divergent'
  | 'source_unavailable';

export class ContainerMountIntegrityError extends Error {
  constructor(
    readonly kind: ContainerMountIntegrityFailureKind,
    message: string,
  ) {
    super(message);
    this.name = 'ContainerMountIntegrityError';
  }
}

export type ResolvedContainerMount = NormalizedContainerMount & {
  resourceId: string;
  sourceIdentity: string;
};

export async function resolveContainerMountIntegrity(
  transaction: Transaction<NyabaseDatabase>,
  container: ContainerAggregate,
  rows: readonly ContainerMountRecord[],
): Promise<ResolvedContainerMount[]> {
  let desiredMounts: NormalizedContainerMount[];
  try {
    desiredMounts = normalizeContainerMounts(container.mountsJson);
  } catch (error) {
    throw new ContainerMountIntegrityError(
      'desired_invalid',
      `Durable desired mount snapshot is invalid: ${errorMessage(error)}`,
    );
  }
  if (rows.length > MAX_CONTAINER_MOUNTS) {
    throw new ContainerMountIntegrityError(
      'index_divergent',
      'Durable container mount index exceeds the supported bound',
    );
  }
  if (rows.some((row) =>
    row.containerId !== container.id
    || row.serverId !== container.serverId
    || row.userId !== container.ownerId
    || !row.sourceIdentity)) {
    throw new ContainerMountIntegrityError(
      'index_divergent',
      'Durable container mount index ownership metadata is inconsistent',
    );
  }
  let indexed: NormalizedContainerMount[];
  try {
    indexed = normalizeContainerMounts(rows.map((row) => ({
      sourceKind: row.sourceKind,
      sourceId: row.sourceId,
      dirName: row.dirName,
      containerPath: row.containerPath,
    })));
  } catch (error) {
    throw new ContainerMountIntegrityError(
      'index_divergent',
      `Durable container mount index is invalid: ${errorMessage(error)}`,
    );
  }
  const desiredIdentities = desiredMounts.map(mountIdentity).sort();
  const indexedIdentities = indexed.map(mountIdentity).sort();
  if (
    desiredIdentities.length !== indexedIdentities.length
    || desiredIdentities.some((value, index) => value !== indexedIdentities[index])
  ) {
    throw new ContainerMountIntegrityError(
      'index_divergent',
      'Durable desired mount snapshot and mount index have different entries',
    );
  }
  const byIdentity = new Map(rows.map((row) => [
    mountIdentity(row),
    row,
  ]));
  const lookupInputs = desiredMounts.map((mount, ordinal) => ({
    ordinal,
    sourceKind: mount.sourceKind,
    sourceId: mount.sourceId,
    dirName: mount.dirName,
  }));
  const directoryResult = await sql<{
    ordinal: number;
    id: string | null;
    source_identity: string | null;
    match_count: number;
  }>`
    WITH inputs AS (
      SELECT
        (entry.value ->> 'ordinal')::integer AS ordinal,
        entry.value ->> 'sourceKind' AS source_kind,
        entry.value ->> 'sourceId' AS source_id,
        entry.value ->> 'dirName' AS dir_name
      FROM jsonb_array_elements(${JSON.stringify(lookupInputs)}::jsonb) AS entry(value)
    )
    SELECT
      inputs.ordinal,
      matched.id,
      matched.source_identity,
      count(matched.id) OVER (PARTITION BY inputs.ordinal)::integer AS match_count
    FROM inputs
    LEFT JOIN LATERAL (
      SELECT directory.id, directory.source_identity
      FROM control.data_directories AS directory
      WHERE directory.source_kind = inputs.source_kind
        AND directory.source_id = inputs.source_id
        AND directory.name = inputs.dir_name
        AND directory.user_id = ${container.ownerId}::uuid
        AND directory.desired_state = 'active'
        AND (
          (inputs.source_kind = 'local' AND directory.server_id = ${container.serverId}::uuid)
          OR (inputs.source_kind = 'remote' AND directory.server_id IS NULL)
        )
      ORDER BY directory.id
      LIMIT 2
    ) AS matched ON TRUE
    ORDER BY inputs.ordinal, matched.id
  `.execute(transaction);
  const directoryRows = new Map<number, typeof directoryResult.rows>();
  for (const row of directoryResult.rows) {
    const bucket = directoryRows.get(row.ordinal) ?? [];
    bucket.push(row);
    directoryRows.set(row.ordinal, bucket);
  }

  const remoteSourceIds = [...new Set(desiredMounts
    .filter((mount) => mount.sourceKind === 'remote')
    .map((mount) => mount.sourceId))];
  const remoteResult = remoteSourceIds.length === 0
    ? { rows: [] as Array<{
        source_id: string;
        assignment_count: number;
        params: unknown | null;
      }> }
    : await sql<{
        source_id: string;
        assignment_count: number;
        params: unknown | null;
      }>`
        WITH inputs AS (
          SELECT (value #>> '{}')::uuid AS source_id
          FROM jsonb_array_elements(${JSON.stringify(remoteSourceIds)}::jsonb)
        )
        SELECT
          inputs.source_id::text AS source_id,
          (
            SELECT count(*)::integer
            FROM (
              SELECT assignment.id
              FROM infra.remote_fs_server_assignments AS assignment
              WHERE assignment.remote_fs_mount_id = inputs.source_id
                AND assignment.server_id = ${container.serverId}::uuid
                AND assignment.desired_state = 'active'
              LIMIT 2
            ) AS active_assignments
          ) AS assignment_count,
          remote.params
        FROM inputs
        LEFT JOIN infra.remote_fs_mounts AS remote
          ON remote.id = inputs.source_id
          AND remote.desired_state = 'active'
      `.execute(transaction);
  const remoteBySourceId = new Map(
    remoteResult.rows.map((row) => [row.source_id, row]),
  );

  const resolved: ResolvedContainerMount[] = [];
  for (const [ordinal, mount] of desiredMounts.entries()) {
    const indexedRow = byIdentity.get(mountIdentity(mount));
    if (!indexedRow) {
      throw new ContainerMountIntegrityError(
        'index_divergent',
        'Durable desired mount snapshot and mount index have different entries',
      );
    }
    const directoryMatches = directoryRows.get(ordinal) ?? [];
    const directory = directoryMatches[0];
    if (
      directoryMatches.length !== 1
      || directory?.match_count !== 1
      || !directory.id
      || !directory.source_identity
    ) {
      throw new ContainerMountIntegrityError(
        'source_unavailable',
        'A durable container mount no longer resolves to one exact active DataDir identity',
      );
    }
    if (directory.source_identity !== indexedRow.sourceIdentity) {
      throw new ContainerMountIntegrityError(
        'source_unavailable',
        'A durable container mount no longer resolves to its indexed DataDir identity',
      );
    }
    if (mount.sourceKind === 'remote') {
      const remote = remoteBySourceId.get(mount.sourceId);
      let identityMatches = false;
      try {
        identityMatches = Boolean(
          remote?.params
          && remoteFsSourceIdentity(remote.params as RemoteFsParams)
            === directory.source_identity,
        );
      } catch {
        identityMatches = false;
      }
      if (remote?.assignment_count !== 1 || !identityMatches) {
        throw new ContainerMountIntegrityError(
          'source_unavailable',
          'A durable remote container mount no longer has one exact active Server assignment',
        );
      }
    }
    resolved.push({
      ...mount,
      resourceId: directory.id,
      sourceIdentity: directory.source_identity,
    });
  }
  return resolved;
}

function mountIdentity(mount: {
  sourceKind: string;
  sourceId: string;
  dirName: string;
  containerPath: string;
}): string {
  return [
    mount.sourceKind,
    mount.sourceId,
    mount.dirName,
    mount.containerPath,
  ].join('\u0000');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
