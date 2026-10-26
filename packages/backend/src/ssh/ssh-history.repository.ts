import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import type { SshProxyChannelRecord, SshProxyConnectionRecord } from '@nyabase/common';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { peerIp, type HistoryBatch, type RefusalRow } from './ssh-history-records.js';

/** A live connection as the proxy's status report shows it. */
export interface LiveConnectionCounters {
  connectionSeq: number;
  bytesFromClient: number;
  bytesToClient: number;
  channels: Array<{ channelSeq: number; bytesFromClient: number; bytesToClient: number }>;
}

/** Connections of a vanished proxy are closed as lost after this long without a report. */
export const LOST_AFTER = '10 minutes';
/**
 * A connection missing from a complete status report (nothing omitted,
 * nothing waiting to be sent) is closed as lost once it has been unseen for
 * this long; the margin covers a close record still in flight.
 */
const MISSING_LOST_AFTER = '2 minutes';
/** Expired connections folded per statement. */
const FOLD_BATCH = 5_000;

/**
 * Writes of the SSH connection history. Every write is an idempotent upsert
 * keyed by the proxy instance and its sequence numbers: counters only grow,
 * a close is kept once known, and a real close replaces a 'lost' one.
 */
@Injectable()
export class SshHistoryRepository {
  constructor(
    @Inject(PG_DATABASE)
    private readonly database: Kysely<NyabaseDatabase>,
  ) {}

  async store(instance: string, proxyId: string, batch: HistoryBatch): Promise<void> {
    if (batch.connections.length + batch.channels.length + batch.refusals.length === 0) return;
    await this.database.transaction().execute(async (transaction) => {
      if (batch.connections.length > 0) {
        await upsertConnections(transaction, instance, proxyId, batch.connections);
      }
      if (batch.channels.length > 0) await upsertChannels(transaction, instance, batch.channels);
      if (batch.refusals.length > 0) await insertRefusals(transaction, instance, batch.refusals);
    });
  }

  /**
   * Byte counts of live connections and their channels, from a status
   * report. With `complete` (no detail omitted, no history pending) an open
   * row the report no longer lists lost its close record and is closed.
   */
  async checkpoint(
    instance: string,
    live: readonly LiveConnectionCounters[],
    complete: boolean,
  ): Promise<void> {
    const connections = JSON.stringify(live.map((connection) => ({
      connection_seq: connection.connectionSeq,
      bytes_from_client: connection.bytesFromClient,
      bytes_to_client: connection.bytesToClient,
    })));
    const channels = JSON.stringify(live.flatMap((connection) => connection.channels.map((channel) => ({
      connection_seq: connection.connectionSeq,
      channel_seq: channel.channelSeq,
      bytes_from_client: channel.bytesFromClient,
      bytes_to_client: channel.bytesToClient,
    }))));
    await sql`
      UPDATE interaction.ssh_proxy_connections c SET
        bytes_from_client = GREATEST(c.bytes_from_client, r.bytes_from_client),
        bytes_to_client = GREATEST(c.bytes_to_client, r.bytes_to_client),
        last_seen_at = clock_timestamp()
      FROM jsonb_to_recordset(${connections}::jsonb)
        AS r(connection_seq bigint, bytes_from_client bigint, bytes_to_client bigint)
      WHERE c.proxy_instance = ${instance}
        AND c.connection_seq = r.connection_seq
        AND c.closed_at IS NULL
    `.execute(this.database);
    await sql`
      UPDATE interaction.ssh_proxy_channels c SET
        bytes_from_client = GREATEST(c.bytes_from_client, r.bytes_from_client),
        bytes_to_client = GREATEST(c.bytes_to_client, r.bytes_to_client)
      FROM jsonb_to_recordset(${channels}::jsonb)
        AS r(connection_seq bigint, channel_seq bigint, bytes_from_client bigint, bytes_to_client bigint)
      WHERE c.proxy_instance = ${instance}
        AND c.connection_seq = r.connection_seq
        AND c.channel_seq = r.channel_seq
        AND c.closed_at IS NULL
    `.execute(this.database);
    if (!complete) return;
    const listed = live.map((connection) => connection.connectionSeq);
    await sql`
      UPDATE interaction.ssh_proxy_connections SET
        closed_at = last_seen_at,
        close_reason = 'lost'
      WHERE proxy_instance = ${instance}
        AND closed_at IS NULL
        AND NOT (connection_seq = ANY(${listed}::bigint[]))
        AND last_seen_at < clock_timestamp() - ${MISSING_LOST_AFTER}::interval
    `.execute(this.database);
  }

  /**
   * Closes as lost: open connections of proxy instances that stopped
   * reporting (not in `connectedInstances`), and open channels of
   * connections closed for a while (their close record never arrived).
   */
  async closeLost(connectedInstances: readonly string[]): Promise<void> {
    await sql`
      UPDATE interaction.ssh_proxy_connections SET
        closed_at = last_seen_at,
        close_reason = 'lost'
      WHERE closed_at IS NULL
        AND last_seen_at < clock_timestamp() - ${LOST_AFTER}::interval
        AND NOT (proxy_instance = ANY(${[...connectedInstances]}::text[]))
    `.execute(this.database);
    await sql`
      UPDATE interaction.ssh_proxy_channels ch SET
        closed_at = GREATEST(ch.opened_at, c.closed_at),
        close_reason = 'lost'
      FROM interaction.ssh_proxy_connections c
      WHERE ch.closed_at IS NULL
        AND c.proxy_instance = ch.proxy_instance
        AND c.connection_seq = ch.connection_seq
        AND c.closed_at < clock_timestamp() - ${LOST_AFTER}::interval
    `.execute(this.database);
  }

  /**
   * Folds connections closed before `cutoff` (with all their channels) into
   * per-day usage and deletes them, and deletes refusals older than it.
   * Returns how many connections were folded.
   */
  async foldExpired(cutoff: Date): Promise<number> {
    let folded = 0;
    for (;;) {
      const result = await sql<{ folded: string }>`
        WITH expired AS (
          DELETE FROM interaction.ssh_proxy_connections
          WHERE id IN (
            SELECT id FROM interaction.ssh_proxy_connections
            WHERE closed_at < ${cutoff}
            LIMIT ${FOLD_BATCH}
          )
          RETURNING *
        ), expired_channels AS (
          DELETE FROM interaction.ssh_proxy_channels ch
          USING expired e
          WHERE ch.proxy_instance = e.proxy_instance AND ch.connection_seq = e.connection_seq
          RETURNING ch.*, e.user_id, e.username
        ), connection_usage AS (
          INSERT INTO interaction.ssh_proxy_daily_usage AS d
            (day, user_id, username, container_id, connections, bytes_from_client, bytes_to_client)
          SELECT (connected_at AT TIME ZONE 'UTC')::date, user_id, max(username), NULL,
            count(*), sum(bytes_from_client), sum(bytes_to_client)
          FROM expired
          GROUP BY 1, 2
          ON CONFLICT ON CONSTRAINT ssh_proxy_daily_usage_key DO UPDATE SET
            username = excluded.username,
            connections = d.connections + excluded.connections,
            bytes_from_client = d.bytes_from_client + excluded.bytes_from_client,
            bytes_to_client = d.bytes_to_client + excluded.bytes_to_client
          RETURNING 1
        ), container_usage AS (
          INSERT INTO interaction.ssh_proxy_daily_usage AS d
            (day, user_id, username, container_id, container_name, server_id, server_slug,
             connections, channels, bytes_from_client, bytes_to_client)
          SELECT (opened_at AT TIME ZONE 'UTC')::date, user_id, max(username), container_id,
            max(container_name), (array_agg(server_id))[1], max(server_slug),
            count(DISTINCT (proxy_instance, connection_seq)), count(*),
            sum(bytes_from_client), sum(bytes_to_client)
          FROM expired_channels
          WHERE result = 'opened' AND container_id IS NOT NULL
          GROUP BY 1, 2, 4
          ON CONFLICT ON CONSTRAINT ssh_proxy_daily_usage_key DO UPDATE SET
            username = excluded.username,
            container_name = excluded.container_name,
            server_id = excluded.server_id,
            server_slug = excluded.server_slug,
            connections = d.connections + excluded.connections,
            channels = d.channels + excluded.channels,
            bytes_from_client = d.bytes_from_client + excluded.bytes_from_client,
            bytes_to_client = d.bytes_to_client + excluded.bytes_to_client
          RETURNING 1
        )
        -- Data-modifying CTEs always run to completion, read or not.
        SELECT count(*) AS folded FROM expired
      `.execute(this.database);
      const count = Number(result.rows[0]?.folded ?? 0);
      folded += count;
      if (count < FOLD_BATCH) break;
    }
    await this.database
      .deleteFrom('interaction.ssh_proxy_refusals')
      .where('window_start', '<', cutoff)
      .execute();
    return folded;
  }
}

async function upsertConnections(
  executor: Kysely<NyabaseDatabase>,
  instance: string,
  proxyId: string,
  records: readonly SshProxyConnectionRecord[],
): Promise<void> {
  const rows = JSON.stringify(records.map((record) => ({
    connection_seq: record.connectionSeq,
    peer: record.peer,
    peer_ip: peerIp(record.peer),
    client_version: record.clientVersion,
    login: record.login,
    user_id: record.userId,
    username: record.username,
    key_fingerprint: record.keyFingerprint,
    key_algorithm: record.keyAlgorithm,
    pinned_server_id: record.pinned?.serverId ?? null,
    pinned_server_slug: record.pinned?.serverSlug ?? null,
    pinned_container_id: record.pinned?.containerId ?? null,
    pinned_container_name: record.pinned?.containerName ?? null,
    connected_at: record.connectedAt,
    authenticated_at: record.authenticatedAt,
    closed_at: record.closedAt,
    close_reason: record.closedAt === null ? null : record.closeReason ?? 'closed',
    bytes_from_client: record.bytesFromClient,
    bytes_to_client: record.bytesToClient,
    channels_opened: record.channelsOpened,
    channels_rejected: record.channelsRejected,
    rejected_requests: record.rejectedRequests,
  })));
  await sql`
    INSERT INTO interaction.ssh_proxy_connections AS c (
      proxy_instance, connection_seq, proxy_id, peer, peer_ip, client_version, login,
      user_id, username, key_fingerprint, key_algorithm,
      pinned_server_id, pinned_server_slug, pinned_container_id, pinned_container_name,
      connected_at, authenticated_at, closed_at, close_reason, last_seen_at,
      bytes_from_client, bytes_to_client, channels_opened, channels_rejected, rejected_requests
    )
    SELECT ${instance}, r.connection_seq, ${proxyId}, r.peer, r.peer_ip, r.client_version, r.login,
      r.user_id, r.username, r.key_fingerprint, r.key_algorithm,
      r.pinned_server_id, r.pinned_server_slug, r.pinned_container_id, r.pinned_container_name,
      to_timestamp(r.connected_at / 1000.0), to_timestamp(r.authenticated_at / 1000.0),
      to_timestamp(r.closed_at / 1000.0), r.close_reason, clock_timestamp(),
      r.bytes_from_client, r.bytes_to_client, r.channels_opened, r.channels_rejected,
      r.rejected_requests
    FROM jsonb_to_recordset(${rows}::jsonb) AS r(
      connection_seq bigint, peer text, peer_ip text, client_version text, login text,
      user_id uuid, username text, key_fingerprint text, key_algorithm text,
      pinned_server_id uuid, pinned_server_slug text, pinned_container_id uuid,
      pinned_container_name text, connected_at bigint, authenticated_at bigint,
      closed_at bigint, close_reason text, bytes_from_client bigint, bytes_to_client bigint,
      channels_opened bigint, channels_rejected bigint, rejected_requests jsonb
    )
    ON CONFLICT (proxy_instance, connection_seq) DO UPDATE SET
      client_version = COALESCE(excluded.client_version, c.client_version),
      pinned_server_id = COALESCE(excluded.pinned_server_id, c.pinned_server_id),
      pinned_server_slug = COALESCE(excluded.pinned_server_slug, c.pinned_server_slug),
      pinned_container_id = COALESCE(excluded.pinned_container_id, c.pinned_container_id),
      pinned_container_name = COALESCE(excluded.pinned_container_name, c.pinned_container_name),
      closed_at = CASE WHEN excluded.closed_at IS NOT NULL THEN excluded.closed_at ELSE c.closed_at END,
      close_reason = CASE WHEN excluded.closed_at IS NOT NULL THEN excluded.close_reason ELSE c.close_reason END,
      last_seen_at = GREATEST(c.last_seen_at, excluded.last_seen_at),
      bytes_from_client = GREATEST(c.bytes_from_client, excluded.bytes_from_client),
      bytes_to_client = GREATEST(c.bytes_to_client, excluded.bytes_to_client),
      channels_opened = GREATEST(c.channels_opened, excluded.channels_opened),
      channels_rejected = GREATEST(c.channels_rejected, excluded.channels_rejected),
      rejected_requests = (
        SELECT COALESCE(jsonb_object_agg(kind, GREATEST(
          COALESCE((c.rejected_requests ->> kind)::bigint, 0),
          COALESCE((excluded.rejected_requests ->> kind)::bigint, 0)
        )), '{}'::jsonb)
        FROM (
          SELECT jsonb_object_keys(c.rejected_requests)
          UNION SELECT jsonb_object_keys(excluded.rejected_requests)
        ) AS kinds(kind)
      )
  `.execute(executor);
}

async function upsertChannels(
  executor: Kysely<NyabaseDatabase>,
  instance: string,
  records: readonly SshProxyChannelRecord[],
): Promise<void> {
  const rows = JSON.stringify(records.map((record) => ({
    connection_seq: record.connectionSeq,
    channel_seq: record.channelSeq,
    target_host: record.targetHost,
    target_port: record.targetPort,
    originator: record.originator,
    server_id: record.route?.serverId ?? null,
    server_slug: record.route?.serverSlug ?? null,
    container_id: record.route?.containerId ?? null,
    container_name: record.route?.containerName ?? null,
    instance_name: record.route?.instanceName ?? null,
    routed_ip: record.route?.routedIp ?? null,
    result: record.result,
    opened_at: record.openedAt,
    closed_at: record.closedAt,
    close_reason: record.closeReason,
    bytes_from_client: record.bytesFromClient,
    bytes_to_client: record.bytesToClient,
  })));
  await sql`
    INSERT INTO interaction.ssh_proxy_channels AS c (
      proxy_instance, connection_seq, channel_seq, target_host, target_port, originator,
      server_id, server_slug, container_id, container_name, instance_name, routed_ip,
      result, opened_at, closed_at, close_reason, bytes_from_client, bytes_to_client
    )
    SELECT ${instance}, r.connection_seq, r.channel_seq, r.target_host, r.target_port, r.originator,
      r.server_id, r.server_slug, r.container_id, r.container_name, r.instance_name, r.routed_ip,
      r.result, to_timestamp(r.opened_at / 1000.0), to_timestamp(r.closed_at / 1000.0),
      r.close_reason, r.bytes_from_client, r.bytes_to_client
    FROM jsonb_to_recordset(${rows}::jsonb) AS r(
      connection_seq bigint, channel_seq bigint, target_host text, target_port bigint,
      originator text, server_id uuid, server_slug text, container_id uuid,
      container_name text, instance_name text, routed_ip text, result text,
      opened_at bigint, closed_at bigint, close_reason text,
      bytes_from_client bigint, bytes_to_client bigint
    )
    ON CONFLICT (proxy_instance, connection_seq, channel_seq) DO UPDATE SET
      server_id = COALESCE(excluded.server_id, c.server_id),
      server_slug = COALESCE(excluded.server_slug, c.server_slug),
      container_id = COALESCE(excluded.container_id, c.container_id),
      container_name = COALESCE(excluded.container_name, c.container_name),
      instance_name = COALESCE(excluded.instance_name, c.instance_name),
      routed_ip = COALESCE(excluded.routed_ip, c.routed_ip),
      closed_at = CASE WHEN excluded.closed_at IS NOT NULL THEN excluded.closed_at ELSE c.closed_at END,
      close_reason = CASE WHEN excluded.closed_at IS NOT NULL THEN excluded.close_reason ELSE c.close_reason END,
      bytes_from_client = GREATEST(c.bytes_from_client, excluded.bytes_from_client),
      bytes_to_client = GREATEST(c.bytes_to_client, excluded.bytes_to_client)
  `.execute(executor);
}

/** A refusal window is stored once: sending it again changes nothing. */
async function insertRefusals(
  executor: Kysely<NyabaseDatabase>,
  instance: string,
  refusals: readonly RefusalRow[],
): Promise<void> {
  const rows = JSON.stringify(refusals.map((refusal) => ({
    window_start: refusal.windowStart,
    window_end: refusal.windowEnd,
    peer_ip: refusal.peerIp,
    reason: refusal.reason,
    count: refusal.count,
  })));
  await sql`
    INSERT INTO interaction.ssh_proxy_refusals
      (proxy_instance, window_start, peer_ip, reason, window_end, count)
    SELECT ${instance}, to_timestamp(r.window_start / 1000.0), r.peer_ip, r.reason,
      to_timestamp(r.window_end / 1000.0), r.count
    FROM jsonb_to_recordset(${rows}::jsonb)
      AS r(window_start bigint, window_end bigint, peer_ip text, reason text, count bigint)
    ON CONFLICT DO NOTHING
  `.execute(executor);
}
