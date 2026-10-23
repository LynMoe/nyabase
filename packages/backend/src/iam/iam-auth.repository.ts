import { Inject, Injectable } from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import type { Role, UserStatus } from '@nyabase/common';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import type {
  AuthPersistence,
  AuthTransactionHook,
  AuthUser,
  LoginCredentialSnapshot,
  NewRefreshSession,
  RefreshRotationInput,
  RefreshRotationResult,
} from './auth-persistence.js';

type IamTransaction = Transaction<NyabaseDatabase>;
const REFRESH_SESSION_PURGE_BATCH_SIZE = 128;
/** A locked refresh session with its owner, as the rotation paths read it. */
const SESSION_USER_COLUMNS = [
  'token.id as token_id',
  'token.user_id',
  'token.expires_at',
  'token.created_at as session_started_at',
  'user.id',
  'user.numeric_id',
  'user.username',
  'user.password_hash',
  'user.display_name',
  'user.status',
  'user.auth_version',
  'user.role',
  'user.created_at',
  'user.updated_at',
] as const;

interface UserRow {
  id: string;
  numeric_id: number;
  username: string;
  password_hash: string;
  display_name: string;
  status: string;
  auth_version: number;
  role: string;
  created_at: Date;
  updated_at: Date;
}

@Injectable()
export class IamAuthRepository implements AuthPersistence {
  constructor(
    @Inject(PG_DATABASE)
    private readonly database: Kysely<NyabaseDatabase>,
    private readonly transactions: PgTransactionManager,
  ) {}

  async findUserByUsername(username: string): Promise<AuthUser | null> {
    const row = await this.database
      .selectFrom('iam.users')
      .selectAll()
      .where('username', '=', username)
      .executeTakeFirst();
    return row ? this.toUser(row as UserRow) : null;
  }

  async findUserById(id: string): Promise<AuthUser | null> {
    const row = await this.database
      .selectFrom('iam.users')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? this.toUser(row as UserRow) : null;
  }

  issueRefreshSession(
    userId: string,
    session: NewRefreshSession,
    maximumSessions: number,
    credentialSnapshot?: LoginCredentialSnapshot,
    onIssued?: AuthTransactionHook<AuthUser>,
  ): Promise<AuthUser | null> {
    return this.transactions.run(async (transaction) => {
      const userRow = await transaction
        .selectFrom('iam.users')
        .selectAll()
        .where('id', '=', userId)
        .forUpdate()
        .executeTakeFirst();
      if (!userRow || userRow.status !== 'active') return null;
      if (
        credentialSnapshot
        && (
          userRow.id !== credentialSnapshot.id
          || userRow.password_hash !== credentialSnapshot.passwordHash
          || userRow.auth_version !== credentialSnapshot.authVersion
        )
      ) {
        return null;
      }

      const now = await this.databaseClock(transaction);
      const expiresAt = new Date(now.getTime() + session.expiresInMs);
      await this.purgeExpiredRefreshSessions(transaction, now);
      await this.trimRefreshSessions(
        transaction,
        userId,
        now,
        maximumSessions - 1,
      );
      await transaction
        .insertInto('iam.refresh_tokens')
        .values({
          id: session.id,
          user_id: userId,
          hash: session.hash,
          previous_hash: null,
          previous_request_id_hash: null,
          rotated_at: null,
          expires_at: expiresAt,
          revoked: false,
          created_at: now,
        })
        .executeTakeFirstOrThrow();
      const user = this.toUser(userRow as UserRow);
      await onIssued?.(transaction, user);
      return user;
    });
  }

  /**
   * One session is one row whose hash rotates in place; `created_at` is the
   * login time and survives every rotation. Each retired hash is kept in
   * `iam.refresh_token_ancestors` until the session row goes away, so a
   * replayed old token is recognised and takes the whole session down.
   */
  rotateRefreshSession(input: RefreshRotationInput): Promise<RefreshRotationResult> {
    return this.transactions.run(async (transaction) => {
      const current = await transaction
        .selectFrom('iam.refresh_tokens as token')
        .innerJoin('iam.users as user', 'user.id', 'token.user_id')
        .select([...SESSION_USER_COLUMNS, 'token.hash as token_hash'])
        .where('token.hash', '=', input.hash)
        .where('token.revoked', '=', false)
        .forUpdate('token')
        .executeTakeFirst();
      if (!current) return this.resolveRetiredRefreshToken(transaction, input);
      if (current.status !== 'active') return { kind: 'invalid' };
      // Sample time only after the candidate row lock has been acquired.
      // A waiter that crosses expiry while blocked must not rotate the row.
      const now = await this.databaseClock(transaction);
      const sessionEnd = current.session_started_at.getTime() + input.absoluteMs;
      if (current.expires_at <= now || sessionEnd <= now.getTime()) {
        await transaction.deleteFrom('iam.refresh_tokens')
          .where('id', '=', current.token_id)
          .execute();
        return { kind: 'invalid' };
      }
      const expiresAt = new Date(Math.min(now.getTime() + input.idleMs, sessionEnd));

      await this.trimRefreshSessions(
        transaction,
        current.user_id,
        now,
        input.maximumSessions - 1,
        current.token_id,
      );
      await transaction
        .insertInto('iam.refresh_token_ancestors')
        .values({ hash: input.hash, session_id: current.token_id })
        .onConflict((conflict) => conflict.column('hash').doNothing())
        .execute();
      const updated = await transaction
        .updateTable('iam.refresh_tokens')
        .set({
          hash: input.successorHash(current.token_id),
          previous_hash: input.hash,
          previous_request_id_hash: input.requestIdHash,
          rotated_at: now,
          expires_at: expiresAt,
        })
        .where('id', '=', current.token_id)
        .where('hash', '=', input.hash)
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows) !== 1) return { kind: 'invalid' };
      return {
        kind: 'rotated',
        sessionId: current.token_id,
        user: this.toUser(current),
        expiresInMs: expiresAt.getTime() - now.getTime(),
      };
    });
  }

  deleteRefreshSessionByCurrentOrPreviousHash(
    hash: string,
    onDeleted?: AuthTransactionHook<string>,
  ): Promise<string | null> {
    return this.transactions.run(async (transaction) => {
      const selected = await transaction
        .selectFrom('iam.refresh_tokens')
        .select(['id', 'user_id'])
        .where((expression) => expression.or([
          expression('hash', '=', hash),
          expression('previous_hash', '=', hash),
        ]))
        .forUpdate()
        .executeTakeFirst();
      if (!selected) return null;
      const deleted = await transaction
        .deleteFrom('iam.refresh_tokens')
        .where('id', '=', selected.id)
        .executeTakeFirst();
      if (Number(deleted.numDeletedRows) !== 1) return null;
      await onDeleted?.(transaction, selected.user_id);
      return selected.user_id;
    });
  }

  /**
   * The presented hash is not current. If a live session retired it:
   *  - immediate predecessor + the same request id: the client lost the
   *    response of that exact rotation; hand back the same successor;
   *  - immediate predecessor + another request id within `reuseGraceMs` of
   *    the rotation: two tabs refreshed concurrently with the shared cookie
   *    (only possible without Web Locks, see the frontend's
   *    `withCrossTabRefreshLock`); refuse the loser, keep the winner's session;
   *  - anything else is reuse of a rotated-out token, i.e. two parties hold
   *    the session: delete it (ancestors cascade) so neither keeps it.
   */
  private async resolveRetiredRefreshToken(
    transaction: IamTransaction,
    input: RefreshRotationInput,
  ): Promise<RefreshRotationResult> {
    const retired = await transaction
      .selectFrom('iam.refresh_token_ancestors as ancestor')
      .innerJoin('iam.refresh_tokens as token', 'token.id', 'ancestor.session_id')
      .innerJoin('iam.users as user', 'user.id', 'token.user_id')
      .select([
        ...SESSION_USER_COLUMNS,
        'token.hash as token_hash',
        'token.previous_hash',
        'token.previous_request_id_hash',
        'token.rotated_at',
      ])
      .where('ancestor.hash', '=', input.hash)
      .where('token.revoked', '=', false)
      .forUpdate('token')
      .executeTakeFirst();
    if (!retired) return { kind: 'invalid' };
    const now = await this.databaseClock(transaction);
    if (retired.previous_hash === input.hash) {
      if (retired.previous_request_id_hash === input.requestIdHash) {
        if (
          retired.status !== 'active'
          || retired.expires_at <= now
          || retired.token_hash !== input.successorHash(retired.token_id)
        ) return { kind: 'invalid' };
        return {
          kind: 'recovered',
          sessionId: retired.token_id,
          user: this.toUser(retired),
          expiresInMs: retired.expires_at.getTime() - now.getTime(),
        };
      }
      if (
        retired.rotated_at
        && now.getTime() - retired.rotated_at.getTime() < input.reuseGraceMs
      ) return { kind: 'superseded' };
    }
    await transaction
      .deleteFrom('iam.refresh_tokens')
      .where('id', '=', retired.token_id)
      .execute();
    const reuse = { userId: retired.user_id, sessionId: retired.token_id };
    await input.onReuse?.(transaction, reuse);
    return { kind: 'reused', ...reuse };
  }

  async revokeBrowserSessions(
    transaction: IamTransaction,
    userId: string,
  ): Promise<void> {
    await transaction
      .deleteFrom('iam.refresh_tokens')
      .where('user_id', '=', userId)
      .execute();
  }

  private async purgeExpiredRefreshSessions(
    transaction: IamTransaction,
    now: Date,
  ): Promise<void> {
    // Login is latency-sensitive. Keep opportunistic global cleanup bounded,
    // and skip rows another login already owns instead of serializing unrelated
    // users behind a cleanup batch.
    await sql`
      WITH candidates AS (
        SELECT id
        FROM iam.refresh_tokens
        WHERE expires_at <= ${now}
        ORDER BY expires_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT ${REFRESH_SESSION_PURGE_BATCH_SIZE}
      )
      DELETE FROM iam.refresh_tokens AS token
      USING candidates
      WHERE token.id = candidates.id
    `.execute(transaction);
    await sql`
      WITH candidates AS (
        SELECT id
        FROM iam.refresh_tokens
        WHERE revoked
        ORDER BY id
        FOR UPDATE SKIP LOCKED
        LIMIT ${REFRESH_SESSION_PURGE_BATCH_SIZE}
      )
      DELETE FROM iam.refresh_tokens AS token
      USING candidates
      WHERE token.id = candidates.id
    `.execute(transaction);
  }

  private async databaseClock(transaction: IamTransaction): Promise<Date> {
    const row = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`
      .execute(transaction);
    const now = row.rows[0]?.now;
    if (!(now instanceof Date)) throw new Error('PostgreSQL clock returned an invalid timestamp');
    return now;
  }

  private async trimRefreshSessions(
    transaction: IamTransaction,
    userId: string,
    now: Date,
    keepCount: number,
    preserveSessionId?: string,
  ): Promise<void> {
    let query = transaction
      .selectFrom('iam.refresh_tokens')
      .select('id')
      .where('user_id', '=', userId)
      .where('revoked', '=', false)
      .where('expires_at', '>', now);
    if (preserveSessionId) query = query.where('id', '!=', preserveSessionId);
    const active = await query
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .forUpdate()
      .execute();
    const overflow = active.slice(0, Math.max(0, active.length - keepCount));
    if (overflow.length === 0) return;
    await transaction
      .deleteFrom('iam.refresh_tokens')
      .where('id', 'in', overflow.map((row) => row.id))
      .execute();
  }

  private toUser(row: UserRow): AuthUser {
    return {
      id: row.id,
      numericId: row.numeric_id,
      username: row.username,
      passwordHash: row.password_hash,
      displayName: row.display_name,
      status: row.status as UserStatus,
      authVersion: row.auth_version,
      role: row.role as Role,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
