import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import {
  Role,
  zListScope,
  zUuid,
  type CursorPaginatedResponse,
  type SshProxyRefusalsDto,
  type SshSessionChannelDto,
  type SshSessionDetailDto,
  type SshSessionDto,
  type SshSessionListQuery,
  type SshSessionRouteDto,
  type SshSessionStatsDto,
  type SshSessionStatsQuery,
} from '@nyabase/common';
import { assertListScope, requireUserId, type Actor } from '../iam/actor.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';

const DEFAULT_PAGE_SIZE = 50;
const TOP_ENTRIES = 10;
const MAX_REFUSAL_SOURCES = 200;
const DAY_MS = 86_400_000;

interface ConnectionRow {
  id: string;
  proxy_id: string;
  proxy_instance: string;
  connection_seq: string;
  peer: string;
  peer_ip: string;
  client_version: string | null;
  login: string;
  user_id: string;
  username: string;
  key_fingerprint: string;
  key_algorithm: string;
  pinned_server_id: string | null;
  pinned_server_slug: string | null;
  pinned_container_id: string | null;
  pinned_container_name: string | null;
  connected_at: Date;
  authenticated_at: Date;
  closed_at: Date | null;
  close_reason: string | null;
  last_seen_at: Date;
  bytes_from_client: string;
  bytes_to_client: string;
  channels_opened: string;
  channels_rejected: string;
  rejected_requests: Record<string, number>;
  targets: SshSessionRouteDto[] | null;
}

interface ChannelRow {
  channel_seq: string;
  target_host: string;
  target_port: string;
  originator: string;
  server_id: string | null;
  server_slug: string | null;
  container_id: string | null;
  container_name: string | null;
  instance_name: string | null;
  routed_ip: string | null;
  result: string;
  opened_at: Date;
  closed_at: Date | null;
  close_reason: string | null;
  bytes_from_client: string;
  bytes_to_client: string;
}

interface Usage {
  connections: number;
  channels: number;
  bytesFromClient: number;
  bytesToClient: number;
}

const num = (value: string | number | null | undefined) => Number(value ?? 0);
const iso = (value: Date | null) => (value === null ? null : value.toISOString());

/** Distinct containers a connection opened channels to, oldest first. */
const TARGETS = sql<SshSessionRouteDto[]>`(
  SELECT jsonb_agg(jsonb_build_object(
    'serverId', t.server_id, 'serverSlug', t.server_slug,
    'containerId', t.container_id, 'containerName', t.container_name
  ) ORDER BY t.channel_seq)
  FROM (
    SELECT DISTINCT ON (ch.container_id)
      ch.container_id, ch.container_name, ch.server_id, ch.server_slug, ch.channel_seq
    FROM interaction.ssh_proxy_channels ch
    WHERE ch.proxy_instance = c.proxy_instance
      AND ch.connection_seq = c.connection_seq
      AND ch.result = 'opened'
      AND ch.container_id IS NOT NULL
    ORDER BY ch.container_id, ch.channel_seq
  ) t
)`;

/** The connection (alias `c`) opened or tried a channel to `column = id`, or is pinned to it. */
function reaches(kind: 'server' | 'container', id: string): RawBuilder<unknown> {
  const pinned = kind === 'server' ? sql.ref('c.pinned_server_id') : sql.ref('c.pinned_container_id');
  const column = kind === 'server' ? sql.ref('ch.server_id') : sql.ref('ch.container_id');
  return sql`(${pinned} = ${id} OR EXISTS (
    SELECT 1 FROM interaction.ssh_proxy_channels ch
    WHERE ch.proxy_instance = c.proxy_instance
      AND ch.connection_seq = c.connection_seq
      AND ${column} = ${id}
  ))`;
}

function where(conditions: readonly RawBuilder<unknown>[]): RawBuilder<unknown> {
  return conditions.length === 0 ? sql`TRUE` : sql.join(conditions, sql` AND `);
}

function encodeCursor(row: ConnectionRow): string {
  return Buffer.from(`${row.connected_at.toISOString()}|${row.id}`).toString('base64url');
}

function decodeCursor(cursor: string): { connectedAt: Date; id: string } {
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const connectedAt = new Date(at ?? '');
  if (Number.isNaN(connectedAt.getTime()) || !zUuid.safeParse(id).success) {
    throw new BadRequestException('Invalid cursor');
  }
  return { connectedAt, id: id! };
}

function toDto(row: ConnectionRow): SshSessionDto {
  return {
    id: row.id,
    proxyId: row.proxy_id,
    peer: row.peer,
    peerIp: row.peer_ip,
    clientVersion: row.client_version,
    login: row.login,
    userId: row.user_id,
    username: row.username,
    keyFingerprint: row.key_fingerprint,
    keyAlgorithm: row.key_algorithm,
    pinned: row.pinned_container_id && row.pinned_server_id
      ? {
        serverId: row.pinned_server_id,
        serverSlug: row.pinned_server_slug ?? '',
        containerId: row.pinned_container_id,
        containerName: row.pinned_container_name ?? '',
      }
      : null,
    connectedAt: row.connected_at.toISOString(),
    authenticatedAt: row.authenticated_at.toISOString(),
    closedAt: iso(row.closed_at),
    closeReason: row.close_reason,
    lastSeenAt: row.last_seen_at.toISOString(),
    bytesFromClient: num(row.bytes_from_client),
    bytesToClient: num(row.bytes_to_client),
    channelsOpened: num(row.channels_opened),
    channelsRejected: num(row.channels_rejected),
    rejectedRequests: row.rejected_requests ?? {},
    targets: row.targets ?? [],
  };
}

function channelDto(row: ChannelRow): SshSessionChannelDto {
  return {
    seq: num(row.channel_seq),
    targetHost: row.target_host,
    targetPort: num(row.target_port),
    originator: row.originator,
    route: row.container_id && row.server_id
      ? {
        serverId: row.server_id,
        serverSlug: row.server_slug ?? '',
        containerId: row.container_id,
        containerName: row.container_name ?? '',
        instanceName: row.instance_name ?? '',
        routedIp: row.routed_ip ?? '',
      }
      : null,
    result: row.result,
    openedAt: row.opened_at.toISOString(),
    closedAt: iso(row.closed_at),
    closeReason: row.close_reason,
    bytesFromClient: num(row.bytes_from_client),
    bytesToClient: num(row.bytes_to_client),
  };
}

interface StatsFilter {
  userId: string | undefined;
  containerId: string | undefined;
  since: Date;
  /** `since` as a UTC date, for daily usage rows. */
  sinceDay: string;
}

interface UsageRow {
  day: string;
  connections: string;
  channels: string;
  bytes_from_client: string;
  bytes_to_client: string;
}

function userOf(filter: StatsFilter, alias: 'c' | 'd'): RawBuilder<unknown> {
  return filter.userId ? sql`${sql.ref(`${alias}.user_id`)} = ${filter.userId}` : sql`TRUE`;
}

function containerOf(filter: StatsFilter, alias: 'ch' | 'd'): RawBuilder<unknown> {
  return filter.containerId ? sql`${sql.ref(`${alias}.container_id`)} = ${filter.containerId}` : sql`TRUE`;
}

/** Connections (alias `c`) in the statistics window and filter. */
function detailWindow(filter: StatsFilter): RawBuilder<unknown> {
  const conditions = [sql`c.connected_at >= ${filter.since}`, userOf(filter, 'c')];
  if (filter.containerId) conditions.push(reaches('container', filter.containerId));
  return where(conditions);
}

/**
 * Reads the SSH connection history. By default (`scope=mine`) a user sees
 * the connections they made, which only ever reach their own containers;
 * `scope=all` is the operator view of everyone's.
 */
@Injectable()
export class SshSessionsService {
  constructor(
    @Inject(PG_DATABASE)
    private readonly database: Kysely<NyabaseDatabase>,
  ) {}

  async list(actor: Actor, query: SshSessionListQuery): Promise<CursorPaginatedResponse<SshSessionDto>> {
    assertListScope(actor, query.scope, Role.Operator);
    const conditions: RawBuilder<unknown>[] = [];
    const userId = query.scope === 'mine' ? requireUserId(actor) : query.userId;
    if (userId) conditions.push(sql`c.user_id = ${userId}`);
    if (query.serverId) conditions.push(reaches('server', query.serverId));
    if (query.containerId) conditions.push(reaches('container', query.containerId));
    if (query.peerIp) conditions.push(sql`c.peer_ip = ${query.peerIp}`);
    if (query.state === 'open') conditions.push(sql`c.closed_at IS NULL`);
    if (query.state === 'closed') conditions.push(sql`c.closed_at IS NOT NULL`);
    if (query.since) conditions.push(sql`c.connected_at >= ${new Date(query.since)}`);
    if (query.until) conditions.push(sql`c.connected_at < ${new Date(query.until)}`);
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      conditions.push(sql`(c.connected_at, c.id) < (${cursor.connectedAt}, ${cursor.id}::uuid)`);
    }
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const result = await sql<ConnectionRow>`
      SELECT c.*, ${TARGETS} AS targets
      FROM interaction.ssh_proxy_connections c
      WHERE ${where(conditions)}
      ORDER BY c.connected_at DESC, c.id DESC
      LIMIT ${limit + 1}
    `.execute(this.database);
    const rows = result.rows.slice(0, limit);
    return {
      items: rows.map(toDto),
      nextCursor: result.rows.length > limit ? encodeCursor(rows[rows.length - 1]!) : null,
    };
  }

  async detail(actor: Actor, id: string, scopeParam: unknown): Promise<SshSessionDetailDto> {
    const scope = zListScope.parse(scopeParam);
    assertListScope(actor, scope, Role.Operator);
    if (!zUuid.safeParse(id).success) throw new NotFoundException('SSH session not found');
    const result = await sql<ConnectionRow>`
      SELECT c.*, ${TARGETS} AS targets
      FROM interaction.ssh_proxy_connections c
      WHERE c.id = ${id}
    `.execute(this.database);
    const row = result.rows[0];
    // Someone else's connection is reported as absent, not forbidden.
    if (!row || (scope === 'mine' && row.user_id !== requireUserId(actor))) {
      throw new NotFoundException('SSH session not found');
    }
    const channels = await sql<ChannelRow>`
      SELECT * FROM interaction.ssh_proxy_channels
      WHERE proxy_instance = ${row.proxy_instance} AND connection_seq = ${row.connection_seq}
      ORDER BY channel_seq
    `.execute(this.database);
    const recordedRejections = channels.rows.filter((channel) => channel.result !== 'opened').length;
    return {
      ...toDto(row),
      channels: channels.rows.map(channelDto),
      unrecordedRejectedChannels: Math.max(0, num(row.channels_rejected) - recordedRejections),
    };
  }

  async stats(actor: Actor, query: SshSessionStatsQuery): Promise<SshSessionStatsDto> {
    assertListScope(actor, query.scope, Role.Operator);
    const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;
    const since = new Date(today - (query.days - 1) * DAY_MS);
    const filter: StatsFilter = {
      userId: query.scope === 'mine' ? requireUserId(actor) : query.userId,
      containerId: query.containerId,
      since,
      sinceDay: since.toISOString().slice(0, 10),
    };
    const [daily, containers, users, breakdowns] = await Promise.all([
      this.dailyUsage(filter, query.days),
      this.containerUsage(filter),
      this.userUsage(filter),
      this.breakdowns(filter),
    ]);
    const sum = (key: keyof Usage) => daily.reduce((total, row) => total + row[key], 0);
    return {
      days: query.days,
      since: since.toISOString(),
      totals: {
        connections: sum('connections'),
        channels: sum('channels'),
        bytesFromClient: sum('bytesFromClient'),
        bytesToClient: sum('bytesToClient'),
        users: users.length,
        containers: containers.length,
      },
      daily,
      topUsers: users.slice(0, TOP_ENTRIES),
      topContainers: containers.slice(0, TOP_ENTRIES),
      ...breakdowns,
    };
  }

  /**
   * Per day: connections and their bytes, or with a container filter the
   * channels to it and their bytes; folded days come from daily usage.
   */
  private async dailyUsage(filter: StatsFilter, days: number): Promise<SshSessionStatsDto['daily']> {
    const connections = await sql<UsageRow>`
      SELECT day::text, sum(connections) AS connections, 0 AS channels,
        sum(bytes_from_client) AS bytes_from_client, sum(bytes_to_client) AS bytes_to_client
      FROM (
        SELECT (c.connected_at AT TIME ZONE 'UTC')::date AS day, count(*) AS connections,
          sum(c.bytes_from_client) AS bytes_from_client, sum(c.bytes_to_client) AS bytes_to_client
        FROM interaction.ssh_proxy_connections c
        WHERE c.connected_at >= ${filter.since} AND ${userOf(filter, 'c')}
        GROUP BY 1
        UNION ALL
        SELECT d.day, d.connections, d.bytes_from_client, d.bytes_to_client
        FROM interaction.ssh_proxy_daily_usage d
        WHERE d.container_id IS NULL AND d.day >= ${filter.sinceDay}::date AND ${userOf(filter, 'd')}
      ) usage
      GROUP BY day
    `.execute(this.database);
    const channels = await sql<UsageRow>`
      SELECT day::text, sum(connections) AS connections, sum(channels) AS channels,
        sum(bytes_from_client) AS bytes_from_client, sum(bytes_to_client) AS bytes_to_client
      FROM (
        SELECT (ch.opened_at AT TIME ZONE 'UTC')::date AS day,
          count(DISTINCT (ch.proxy_instance, ch.connection_seq)) AS connections, count(*) AS channels,
          sum(ch.bytes_from_client) AS bytes_from_client, sum(ch.bytes_to_client) AS bytes_to_client
        FROM interaction.ssh_proxy_channels ch
        JOIN interaction.ssh_proxy_connections c
          ON c.proxy_instance = ch.proxy_instance AND c.connection_seq = ch.connection_seq
        WHERE ch.result = 'opened' AND ch.opened_at >= ${filter.since}
          AND ${userOf(filter, 'c')} AND ${containerOf(filter, 'ch')}
        GROUP BY 1
        UNION ALL
        SELECT d.day, d.connections, d.channels, d.bytes_from_client, d.bytes_to_client
        FROM interaction.ssh_proxy_daily_usage d
        WHERE d.container_id IS NOT NULL AND d.day >= ${filter.sinceDay}::date
          AND ${userOf(filter, 'd')} AND ${containerOf(filter, 'd')}
      ) usage
      GROUP BY day
    `.execute(this.database);
    const daily = new Map<string, Usage>();
    for (let offset = 0; offset < days; offset += 1) {
      const day = new Date(filter.since.getTime() + offset * DAY_MS).toISOString().slice(0, 10);
      daily.set(day, { connections: 0, channels: 0, bytesFromClient: 0, bytesToClient: 0 });
    }
    const whole = filter.containerId ? channels.rows : connections.rows;
    for (const row of whole) {
      const usage = daily.get(row.day);
      if (!usage) continue;
      usage.connections = num(row.connections);
      usage.bytesFromClient = num(row.bytes_from_client);
      usage.bytesToClient = num(row.bytes_to_client);
    }
    for (const row of channels.rows) {
      const usage = daily.get(row.day);
      if (usage) usage.channels = num(row.channels);
    }
    return [...daily].map(([day, usage]) => ({ day, ...usage }));
  }

  /** Every container reached in the window, most traffic first. */
  private async containerUsage(filter: StatsFilter): Promise<SshSessionStatsDto['topContainers']> {
    const result = await sql<{ container_id: string; container_name: string; server_id: string; server_slug: string; channels: string; bytes: string }>`
      SELECT container_id, max(container_name) AS container_name,
        (array_agg(server_id))[1] AS server_id, max(server_slug) AS server_slug,
        sum(channels) AS channels, sum(bytes) AS bytes
      FROM (
        SELECT ch.container_id, ch.container_name, ch.server_id, ch.server_slug,
          count(*) AS channels, sum(ch.bytes_from_client + ch.bytes_to_client) AS bytes
        FROM interaction.ssh_proxy_channels ch
        JOIN interaction.ssh_proxy_connections c
          ON c.proxy_instance = ch.proxy_instance AND c.connection_seq = ch.connection_seq
        WHERE ch.result = 'opened' AND ch.container_id IS NOT NULL AND ch.opened_at >= ${filter.since}
          AND ${userOf(filter, 'c')} AND ${containerOf(filter, 'ch')}
        GROUP BY 1, 2, 3, 4
        UNION ALL
        SELECT d.container_id, d.container_name, d.server_id, d.server_slug, d.channels,
          d.bytes_from_client + d.bytes_to_client
        FROM interaction.ssh_proxy_daily_usage d
        WHERE d.container_id IS NOT NULL AND d.day >= ${filter.sinceDay}::date
          AND ${userOf(filter, 'd')} AND ${containerOf(filter, 'd')}
      ) usage
      GROUP BY container_id
      ORDER BY sum(bytes) DESC, sum(channels) DESC
    `.execute(this.database);
    return result.rows.map((row) => ({
      containerId: row.container_id,
      containerName: row.container_name,
      serverId: row.server_id,
      serverSlug: row.server_slug,
      channels: num(row.channels),
      bytes: num(row.bytes),
    }));
  }

  /** Every user who connected in the window, most traffic first. */
  private async userUsage(filter: StatsFilter): Promise<SshSessionStatsDto['topUsers']> {
    const result = await sql<{ user_id: string; username: string; connections: string; bytes: string }>`
      SELECT user_id, max(username) AS username, sum(connections) AS connections, sum(bytes) AS bytes
      FROM (
        SELECT c.user_id, c.username, count(*) AS connections,
          sum(c.bytes_from_client + c.bytes_to_client) AS bytes
        FROM interaction.ssh_proxy_connections c
        WHERE ${detailWindow(filter)}
        GROUP BY 1, 2
        UNION ALL
        SELECT d.user_id, d.username, d.connections, d.bytes_from_client + d.bytes_to_client
        FROM interaction.ssh_proxy_daily_usage d
        WHERE d.day >= ${filter.sinceDay}::date AND ${userOf(filter, 'd')}
          AND ${filter.containerId ? containerOf(filter, 'd') : sql`d.container_id IS NULL`}
      ) usage
      GROUP BY user_id
      ORDER BY sum(bytes) DESC, sum(connections) DESC
    `.execute(this.database);
    return result.rows.map((row) => ({
      userId: row.user_id,
      username: row.username,
      connections: num(row.connections),
      bytes: num(row.bytes),
    }));
  }

  /** Close reasons and refused requests, from connections still in detail. */
  private async breakdowns(
    filter: StatsFilter,
  ): Promise<Pick<SshSessionStatsDto, 'closeReasons' | 'rejectedRequests'>> {
    const closeReasons = await sql<{ reason: string; count: string }>`
      SELECT c.close_reason AS reason, count(*) AS count
      FROM interaction.ssh_proxy_connections c
      WHERE c.close_reason IS NOT NULL AND ${detailWindow(filter)}
      GROUP BY 1
    `.execute(this.database);
    const rejected = await sql<{ kind: string; count: string }>`
      SELECT r.key AS kind, sum(r.value::bigint) AS count
      FROM interaction.ssh_proxy_connections c, jsonb_each_text(c.rejected_requests) r
      WHERE ${detailWindow(filter)}
      GROUP BY 1
    `.execute(this.database);
    return {
      closeReasons: Object.fromEntries(closeReasons.rows.map((row) => [row.reason, num(row.count)])),
      rejectedRequests: Object.fromEntries(rejected.rows.map((row) => [row.kind, num(row.count)])),
    };
  }

  /** Unauthenticated connections over the last `hours`, for operators. */
  async refusals(hours: number): Promise<SshProxyRefusalsDto> {
    const since = new Date(Date.now() - hours * 3_600_000);
    const hourly = await sql<{ hour: Date; count: string }>`
      SELECT date_trunc('hour', window_start) AS hour, sum(count) AS count
      FROM interaction.ssh_proxy_refusals
      WHERE window_start >= ${since}
      GROUP BY 1 ORDER BY 1
    `.execute(this.database);
    const sources = await sql<{ peer_ip: string; reason: string; count: string; last_seen_at: Date }>`
      SELECT peer_ip, reason, sum(count) AS count, max(window_end) AS last_seen_at
      FROM interaction.ssh_proxy_refusals
      WHERE window_start >= ${since}
      GROUP BY 1, 2
      ORDER BY 3 DESC, 1, 2
      LIMIT ${MAX_REFUSAL_SOURCES}
    `.execute(this.database);
    const reasons = await sql<{ reason: string; count: string }>`
      SELECT reason, sum(count) AS count
      FROM interaction.ssh_proxy_refusals
      WHERE window_start >= ${since}
      GROUP BY 1
    `.execute(this.database);
    const byReason = Object.fromEntries(reasons.rows.map((row) => [row.reason, num(row.count)]));
    return {
      hours,
      total: Object.values(byReason).reduce((total, count) => total + count, 0),
      reasons: byReason,
      topSources: sources.rows.map((row) => ({
        peerIp: row.peer_ip === '' ? null : row.peer_ip,
        reason: row.reason,
        count: num(row.count),
        lastSeenAt: row.last_seen_at.toISOString(),
      })),
      hourly: hourly.rows.map((row) => ({ hour: row.hour.toISOString(), count: num(row.count) })),
    };
  }
}
