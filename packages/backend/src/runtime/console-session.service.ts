import {
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { CreateExecSessionRequest, ExecSessionResponse } from '@nyabase/common';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { RedisDisposableAdapter } from './redis-disposable.adapter.js';

const UNCLAIMED_TTL_MS = 60_000;
const CLAIMED_TTL_MS = 30 * 60_000;

export interface ConsoleSession {
  sessionId: string;
  actorId: string;
  authVersion: number;
  containerId: string;
  serverId: string;
  instanceName: string;
  command: string[];
  tty: boolean;
  cols: number;
  rows: number;
  admin: boolean;
  state: 'unclaimed' | 'claimed';
  expiresAt: string;
}

@Injectable()
export class ConsoleSessionService {
  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly redis: RedisDisposableAdapter,
  ) {}

  async create(
    actorId: string,
    authVersion: number,
    containerId: string,
    request: CreateExecSessionRequest,
    admin: boolean,
  ): Promise<ExecSessionResponse> {
    const row = await this.database
      .selectFrom('control.containers as container')
      .innerJoin('control.container_ssh_routes as route', 'route.container_id', 'container.id')
      .select([
        'container.id as container_id',
        'container.server_id',
        'container.lifecycle_phase',
        'route.instance_name',
        'route.instance_status',
      ])
      .where('container.id', '=', containerId)
      .executeTakeFirst();
    if (
      !row
      || row.lifecycle_phase !== 'active'
      || row.instance_status.toLowerCase() !== 'running'
    ) {
      throw new ConflictException({
        code: 'INSTANCE_BUSY',
        message: 'The container is not ready for an exec session',
      });
    }
    const sessionId = randomUUID();
    const expiresAt = new Date(Date.now() + UNCLAIMED_TTL_MS).toISOString();
    const session: ConsoleSession = {
      sessionId,
      actorId,
      authVersion,
      containerId: row.container_id,
      serverId: row.server_id,
      instanceName: row.instance_name,
      command: [...request.command],
      tty: request.tty,
      cols: request.cols,
      rows: request.rows,
      admin,
      state: 'unclaimed',
      expiresAt,
    };
    if (!await this.redis.setEphemeral(
      `console-session:${sessionId}`,
      JSON.stringify(session),
      UNCLAIMED_TTL_MS,
    )) {
      throw new ServiceUnavailableException({
        code: 'CONSOLE_SESSION_UNAVAILABLE',
        message: 'Console session storage is unavailable',
      });
    }
    return {
      sessionId,
      consoleUrl: `/ws/console?sessionId=${encodeURIComponent(sessionId)}`,
      expiresAt,
    };
  }

  async claim(
    sessionId: string,
    actorId: string,
    authVersion: number,
  ): Promise<ConsoleSession | null> {
    const raw = await this.redis.getEphemeral(`console-session:${sessionId}`);
    if (!raw) return null;
    let session: ConsoleSession;
    try {
      session = JSON.parse(raw) as ConsoleSession;
    } catch {
      await this.release(sessionId);
      return null;
    }
    if (
      session.sessionId !== sessionId
      || session.actorId !== actorId
      || session.authVersion !== authVersion
      || session.state !== 'unclaimed'
    ) return null;
    if (!await this.redis.setEphemeral(
      `console-claim:${sessionId}`,
      actorId,
      CLAIMED_TTL_MS,
      true,
    )) return null;
    session.state = 'claimed';
    session.expiresAt = new Date(Date.now() + CLAIMED_TTL_MS).toISOString();
    if (!await this.redis.setEphemeral(
      `console-session:${sessionId}`,
      JSON.stringify(session),
      CLAIMED_TTL_MS,
    )) {
      await this.release(sessionId);
      return null;
    }
    const current = await this.database
      .selectFrom('control.containers as container')
      .innerJoin('control.container_ssh_routes as route', 'route.container_id', 'container.id')
      .select([
        'container.server_id',
        'container.instance_name',
        'container.lifecycle_phase',
        'route.instance_name',
        'route.instance_status',
      ])
      .where('container.id', '=', session.containerId)
      .executeTakeFirst();
    if (
      !current
      || current.server_id !== session.serverId
      || current.lifecycle_phase !== 'active'
      || current.instance_name !== session.instanceName
      || current.instance_status.toLowerCase() !== 'running'
    ) {
      await this.release(sessionId);
      return null;
    }
    return session;
  }

  async release(sessionId: string): Promise<void> {
    await Promise.all([
      this.redis.deleteEphemeral(`console-session:${sessionId}`),
      this.redis.deleteEphemeral(`console-claim:${sessionId}`),
    ]);
  }
}
