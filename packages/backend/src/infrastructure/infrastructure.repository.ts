import { Inject, Injectable } from '@nestjs/common';
import type { ImageRuntimeOverrides } from '@nyabase/common';
import type { Kysely, Selectable, Transaction } from 'kysely';
import { sql } from 'kysely';
import type { ImageRecord, ServerRecord } from '../domain/domain-records.js';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import type {
  InfrastructureImageTable,
  InfrastructureServerTable,
} from './infrastructure-database.types.js';

export type InfrastructureExecutor =
  | Kysely<NyabaseDatabase>
  | Transaction<NyabaseDatabase>;

export const INFRASTRUCTURE_ADVISORY_NAMESPACE = 1_856_214_885;
export const SERVER_CAPACITY_ADVISORY_KEY = 5;
export const IMAGE_CAPACITY_ADVISORY_KEY = 6;

export interface ServerInsert {
  id: string;
  name: string;
  slug: string;
  agentTokenHash: string;
  macvlanCidr?: string | null;
  macvlanGateway?: string | null;
  macvlanReservedIps?: string[];
}

export interface AgentAdmissionUpdate {
  hostFingerprint: string;
  agentConfigFingerprint: string;
  status: ServerRecord['status'];
  lastSeenAt: Date;
  macvlanCidr?: string | null;
  macvlanGateway?: string | null;
  macvlanReservedIps?: string[];
}

export interface ImageInsert {
  id: string;
  name: string;
  dockerImage: string;
  runtimeOverrides: ImageRuntimeOverrides;
  description: string | null;
  isActive: boolean;
  disableSsh: boolean;
}

@Injectable()
export class InfrastructureRepository {
  constructor(
    @Inject(PG_DATABASE)
    private readonly database: Kysely<NyabaseDatabase>,
  ) {}

  executor(executor?: InfrastructureExecutor): InfrastructureExecutor {
    return executor ?? this.database;
  }

  async lockServerCapacity(executor: InfrastructureExecutor): Promise<void> {
    await sql`select pg_advisory_xact_lock(
      ${INFRASTRUCTURE_ADVISORY_NAMESPACE},
      ${SERVER_CAPACITY_ADVISORY_KEY}
    )`.execute(executor);
  }

  async lockImageCapacity(executor: InfrastructureExecutor): Promise<void> {
    await sql`select pg_advisory_xact_lock(
      ${INFRASTRUCTURE_ADVISORY_NAMESPACE},
      ${IMAGE_CAPACITY_ADVISORY_KEY}
    )`.execute(executor);
  }

  async countServers(executor: InfrastructureExecutor = this.database): Promise<number> {
    const row = await executor
      .selectFrom('infra.servers')
      .select((expression) => expression.fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async listServers(
    executor: InfrastructureExecutor = this.database,
  ): Promise<ServerRecord[]> {
    const rows = await executor
      .selectFrom('infra.servers')
      .selectAll()
      .orderBy('name')
      .orderBy('id')
      .execute();
    return rows.map(toServer);
  }

  async findServerById(
    id: string,
    executor: InfrastructureExecutor = this.database,
  ): Promise<ServerRecord | null> {
    const row = await executor
      .selectFrom('infra.servers')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? toServer(row) : null;
  }

  async findServerBySlug(
    slug: string,
    executor: InfrastructureExecutor = this.database,
  ): Promise<ServerRecord | null> {
    const row = await executor
      .selectFrom('infra.servers')
      .selectAll()
      .where('slug', '=', slug)
      .executeTakeFirst();
    return row ? toServer(row) : null;
  }

  async findServerByTokenHash(
    tokenHash: string,
    executor: InfrastructureExecutor = this.database,
  ): Promise<ServerRecord | null> {
    const row = await executor
      .selectFrom('infra.servers')
      .selectAll()
      .where('agent_token_hash', '=', tokenHash)
      .executeTakeFirst();
    return row ? toServer(row) : null;
  }

  async insertServer(
    input: ServerInsert,
    executor: InfrastructureExecutor = this.database,
  ): Promise<ServerRecord> {
    const row = await executor
      .insertInto('infra.servers')
      .values({
        id: input.id,
        name: input.name,
        slug: input.slug,
        agent_token_hash: input.agentTokenHash,
        host_fingerprint: null,
        agent_config_fingerprint: null,
        status: 'unknown',
        quarantine_code: null,
        quarantine_message: null,
        last_seen_at: null,
        macvlan_cidr: input.macvlanCidr ?? null,
        macvlan_gateway: input.macvlanGateway ?? null,
        macvlan_reserved_ips: JSON.stringify(input.macvlanReservedIps ?? []),
        revision: 1,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toServer(row);
  }

  async updateServerIdentity(
    id: string,
    patch: { name?: string; slug?: string },
    executor: InfrastructureExecutor = this.database,
  ): Promise<ServerRecord | null> {
    const values: {
      name?: string;
      slug?: string;
      revision: ReturnType<typeof sql<string | number | bigint>>;
    } = {
      revision: sql<string | number | bigint>`revision + 1`,
    };
    if (patch.name !== undefined) values.name = patch.name;
    if (patch.slug !== undefined) values.slug = patch.slug;
    const row = await executor
      .updateTable('infra.servers')
      .set(values)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    return row ? toServer(row) : null;
  }

  async replaceAgentTokenHash(
    id: string,
    agentTokenHash: string,
    executor: InfrastructureExecutor = this.database,
  ): Promise<ServerRecord | null> {
    const row = await executor
      .updateTable('infra.servers')
      .set({
        agent_token_hash: agentTokenHash,
        revision: sql`revision + 1`,
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    return row ? toServer(row) : null;
  }

  /**
   * Atomically binds the first authenticated Agent. A later host mismatch
   * updates no rows, so callers can quarantine without overwriting identity.
   */
  async admitAgent(
    id: string,
    update: AgentAdmissionUpdate,
    executor: InfrastructureExecutor = this.database,
  ): Promise<ServerRecord | null> {
    const row = await executor
      .updateTable('infra.servers')
      .set({
        host_fingerprint: update.hostFingerprint,
        agent_config_fingerprint: update.agentConfigFingerprint,
        status: update.status,
        last_seen_at: update.lastSeenAt,
        ...(update.macvlanCidr !== undefined
          ? { macvlan_cidr: update.macvlanCidr }
          : {}),
        ...(update.macvlanGateway !== undefined
          ? { macvlan_gateway: update.macvlanGateway }
          : {}),
        ...(update.macvlanReservedIps !== undefined
          ? { macvlan_reserved_ips: JSON.stringify(update.macvlanReservedIps) }
          : {}),
        quarantine_code: null,
        quarantine_message: null,
        revision: sql`revision + 1`,
      })
      .where('id', '=', id)
      .where((expression) => expression.or([
        expression('host_fingerprint', 'is', null),
        expression('host_fingerprint', '=', update.hostFingerprint),
      ]))
      .returningAll()
      .executeTakeFirst();
    return row ? toServer(row) : null;
  }

  async quarantineServer(
    id: string,
    code: string,
    message: string | null,
    executor: InfrastructureExecutor = this.database,
    lastSeenAt = new Date(),
  ): Promise<ServerRecord | null> {
    const row = await executor
      .updateTable('infra.servers')
      .set({
        status: 'agent_quarantined',
        quarantine_code: code,
        quarantine_message: message,
        last_seen_at: lastSeenAt,
        revision: sql`revision + 1`,
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    return row ? toServer(row) : null;
  }

  async updateServerLiveness(
    id: string,
    status: ServerRecord['status'],
    options: { clearInventoryFaultCode?: string } = {},
    executor: InfrastructureExecutor = this.database,
  ): Promise<ServerRecord | null> {
    const revision = options.clearInventoryFaultCode
      ? sql<string | number | bigint>`
          CASE
            WHEN status IS DISTINCT FROM ${status}
              OR quarantine_code = ${options.clearInventoryFaultCode}
            THEN revision + 1
            ELSE revision
          END
        `
      : sql<string | number | bigint>`
          CASE
            WHEN status IS DISTINCT FROM ${status} THEN revision + 1
            ELSE revision
          END
        `;
    const row = await executor
      .updateTable('infra.servers')
      .set((expression) => ({
        status,
        last_seen_at: new Date(),
        quarantine_code: options.clearInventoryFaultCode
          ? expression.case()
            .when('quarantine_code', '=', options.clearInventoryFaultCode)
            .then(null)
            .else(expression.ref('quarantine_code'))
            .end()
          : expression.ref('quarantine_code'),
        quarantine_message: options.clearInventoryFaultCode
          ? expression.case()
            .when('quarantine_code', '=', options.clearInventoryFaultCode)
            .then(null)
            .else(expression.ref('quarantine_message'))
            .end()
          : expression.ref('quarantine_message'),
        // last_seen_at is an observation, not a configuration/state revision.
        // Keep CAS consumers quiet when only the coalesced heartbeat timestamp
        // advances; real status or quarantine changes still bump revision.
        revision,
      }))
      .where('id', '=', id)
      .where('status', '!=', 'agent_quarantined')
      .returningAll()
      .executeTakeFirst();
    return row ? toServer(row) : null;
  }

  async markAllNonQuarantinedOffline(): Promise<void> {
    await this.database
      .updateTable('infra.servers')
      .set({
        status: 'offline',
        revision: sql`revision + 1`,
      })
      .where('status', '!=', 'agent_quarantined')
      .execute();
  }

  async deleteServer(
    id: string,
    executor: InfrastructureExecutor = this.database,
  ): Promise<boolean> {
    const result = await executor
      .deleteFrom('infra.servers')
      .where('id', '=', id)
      .executeTakeFirst();
    return Number(result.numDeletedRows) === 1;
  }

  async countImages(executor: InfrastructureExecutor = this.database): Promise<number> {
    const row = await executor
      .selectFrom('infra.images')
      .select((expression) => expression.fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async listImages(
    executor: InfrastructureExecutor = this.database,
  ): Promise<ImageRecord[]> {
    const rows = await executor
      .selectFrom('infra.images')
      .selectAll()
      .orderBy('name')
      .orderBy('id')
      .execute();
    return rows.map(toImage);
  }

  async listActiveImages(
    executor: InfrastructureExecutor = this.database,
  ): Promise<ImageRecord[]> {
    const rows = await executor
      .selectFrom('infra.images')
      .selectAll()
      .where('is_active', '=', true)
      .where('deleting', '=', false)
      .orderBy('name')
      .orderBy('id')
      .execute();
    return rows.map(toImage);
  }

  async findImageById(
    id: string,
    executor: InfrastructureExecutor = this.database,
  ): Promise<ImageRecord | null> {
    const row = await executor
      .selectFrom('infra.images')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? toImage(row) : null;
  }

  async lockImage(
    id: string,
    transaction: Transaction<NyabaseDatabase>,
  ): Promise<ImageRecord | null> {
    const row = await transaction
      .selectFrom('infra.images')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    return row ? toImage(row) : null;
  }

  async insertImage(
    input: ImageInsert,
    executor: InfrastructureExecutor = this.database,
  ): Promise<ImageRecord> {
    const row = await executor
      .insertInto('infra.images')
      .values({
        id: input.id,
        name: input.name,
        docker_image: input.dockerImage,
        runtime_overrides: JSON.stringify(input.runtimeOverrides),
        description: input.description,
        is_active: input.isActive,
        disable_ssh: input.disableSsh,
        deleting: false,
        cleanup_generation: 0,
        revision: 1,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toImage(row);
  }

  async updateImageCas(
    id: string,
    expectedRevision: number,
    patch: Partial<Pick<
      ImageRecord,
      'name' | 'runtimeOverrides' | 'description' | 'isActive' | 'disableSsh'
    >>,
    executor: InfrastructureExecutor = this.database,
  ): Promise<ImageRecord | null> {
    const values: Record<string, unknown> = {
      revision: sql`revision + 1`,
    };
    if (patch.name !== undefined) values.name = patch.name;
    if (patch.runtimeOverrides !== undefined) {
      values.runtime_overrides = JSON.stringify(patch.runtimeOverrides);
    }
    if (patch.description !== undefined) values.description = patch.description;
    if (patch.isActive !== undefined) values.is_active = patch.isActive;
    if (patch.disableSsh !== undefined) values.disable_ssh = patch.disableSsh;
    const row = await executor
      .updateTable('infra.images')
      .set(values)
      .where('id', '=', id)
      .where('revision', '=', String(expectedRevision))
      .where('deleting', '=', false)
      .returningAll()
      .executeTakeFirst();
    return row ? toImage(row) : null;
  }

  async markImageDeletingCas(
    id: string,
    expectedRevision: number,
    executor: InfrastructureExecutor = this.database,
  ): Promise<ImageRecord | null> {
    const row = await executor
      .updateTable('infra.images')
      .set({
        is_active: false,
        deleting: true,
        cleanup_generation: sql`cleanup_generation + 1`,
        revision: sql`revision + 1`,
      })
      .where('id', '=', id)
      .where('revision', '=', String(expectedRevision))
      .where('deleting', '=', false)
      .returningAll()
      .executeTakeFirst();
    return row ? toImage(row) : null;
  }

  async deleteImage(
    id: string,
    executor: InfrastructureExecutor = this.database,
  ): Promise<boolean> {
    const result = await executor
      .deleteFrom('infra.images')
      .where('id', '=', id)
      .executeTakeFirst();
    return Number(result.numDeletedRows) === 1;
  }
}

function toServer(row: Selectable<InfrastructureServerTable>): ServerRecord {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    agentTokenHash: row.agent_token_hash,
    hostFingerprint: row.host_fingerprint,
    agentConfigFingerprint: row.agent_config_fingerprint,
    status: row.status as ServerRecord['status'],
    quarantineCode: row.quarantine_code,
    quarantineMessage: row.quarantine_message,
    lastSeenAt: asDate(row.last_seen_at),
    macvlanCidr: row.macvlan_cidr,
    macvlanGateway: row.macvlan_gateway,
    macvlanReservedIps: stringArray(row.macvlan_reserved_ips),
    createdAt: asDate(row.created_at)!,
    updatedAt: asDate(row.updated_at)!,
  };
}

function toImage(row: Selectable<InfrastructureImageTable>): ImageRecord {
  return {
    id: row.id,
    name: row.name,
    dockerImage: row.docker_image,
    runtimeOverrides: imageRuntimeOverrides(row.runtime_overrides),
    description: row.description,
    isActive: row.is_active,
    disableSsh: row.disable_ssh,
    deleting: row.deleting,
    cleanupGeneration: row.cleanup_generation,
    revision: Number(row.revision),
    createdAt: asDate(row.created_at)!,
    updatedAt: asDate(row.updated_at)!,
  };
}

function asDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function imageRuntimeOverrides(value: unknown): ImageRuntimeOverrides {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { uid: 0, entrypoint: null, cmd: null, init: false };
  }
  const record = value as Record<string, unknown>;
  return {
    uid: typeof record.uid === 'number' ? record.uid : 0,
    entrypoint: Array.isArray(record.entrypoint)
      ? record.entrypoint.filter((item): item is string => typeof item === 'string')
      : null,
    cmd: Array.isArray(record.cmd)
      ? record.cmd.filter((item): item is string => typeof item === 'string')
      : null,
    init: record.init === true,
  };
}
