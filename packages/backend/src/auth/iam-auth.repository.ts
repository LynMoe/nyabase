import { Inject, Injectable } from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import type { UserStatus } from '@nyabase/common';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import type {
  AuthApiToken,
  AuthPersistence,
  AuthTransactionHook,
  AuthUser,
  LoginCredentialSnapshot,
  NewRefreshSession,
  RefreshRotationResult,
} from './auth-persistence.js';

type IamTransaction = Transaction<NyabaseDatabase>;
const REFRESH_SESSION_PURGE_BATCH_SIZE = 128;

interface UserRow {
  id: string;
  numeric_id: number;
  username: string;
  password_hash: string;
  display_name: string;
  status: string;
  auth_version: number;
  authz_version: string;
  created_at: Date;
  updated_at: Date;
}

interface ApiTokenRow {
  id: string;
  user_id: string;
  name: string;
  hash: string;
  last_used_at: Date | null;
  created_at: Date;
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

  rotateRefreshSession(input: {
    hash: string;
    requestIdHash: string;
    expiresInMs: number;
    maximumSessions: number;
    successorHash: (sessionId: string) => string;
  }): Promise<RefreshRotationResult> {
    return this.transactions.run(async (transaction) => {
      const current = await transaction
        .selectFrom('iam.refresh_tokens as token')
        .innerJoin('iam.users as user', 'user.id', 'token.user_id')
        .select([
          'token.id as token_id',
          'token.user_id',
          'token.hash',
          'token.expires_at',
          'user.id',
          'user.numeric_id',
          'user.username',
          'user.password_hash',
          'user.display_name',
          'user.status',
          'user.auth_version',
          'user.authz_version',
          'user.created_at',
          'user.updated_at',
        ])
        .where('token.hash', '=', input.hash)
        .where('token.revoked', '=', false)
        .forUpdate('token')
        .executeTakeFirst();

      if (!current) {
        const recovered = await transaction
          .selectFrom('iam.refresh_tokens as token')
          .innerJoin('iam.users as user', 'user.id', 'token.user_id')
          .select([
            'token.id as token_id',
            'token.hash as token_hash',
            'token.expires_at',
            'user.id',
            'user.numeric_id',
            'user.username',
            'user.password_hash',
            'user.display_name',
            'user.status',
            'user.auth_version',
            'user.authz_version',
            'user.created_at',
            'user.updated_at',
          ])
          .where('token.previous_hash', '=', input.hash)
          .where('token.previous_request_id_hash', '=', input.requestIdHash)
          .where('token.revoked', '=', false)
          .forUpdate('token')
          .executeTakeFirst();
        const recoveredNow = await this.databaseClock(transaction);
        if (
          !recovered
          || recovered.status !== 'active'
          || recovered.expires_at <= recoveredNow
          || recovered.token_hash !== input.successorHash(recovered.token_id)
        ) return { kind: 'invalid' };
        return {
          kind: 'recovered',
          sessionId: recovered.token_id,
          user: this.toUser(recovered as UserRow & { token_id: string }),
        };
      }
      if (current.status !== 'active') return { kind: 'invalid' };
      // Sample time only after the candidate row lock has been acquired.
      // A waiter that crosses expiry while blocked must not rotate the row.
      const now = await this.databaseClock(transaction);
      if (current.expires_at <= now) {
        await transaction.deleteFrom('iam.refresh_tokens')
          .where('id', '=', current.token_id)
          .execute();
        return { kind: 'invalid' };
      }
      const expiresAt = new Date(now.getTime() + input.expiresInMs);

      await this.trimRefreshSessions(
        transaction,
        current.user_id,
        now,
        input.maximumSessions - 1,
        current.token_id,
      );
      const updated = await transaction
        .updateTable('iam.refresh_tokens')
        .set({
          hash: input.successorHash(current.token_id),
          previous_hash: input.hash,
          previous_request_id_hash: input.requestIdHash,
          expires_at: expiresAt,
        })
        .where('id', '=', current.token_id)
        .where('hash', '=', input.hash)
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows) !== 1) return { kind: 'invalid' };
      return {
        kind: 'rotated',
        sessionId: current.token_id,
        user: this.toUser(current as UserRow & { token_id: string }),
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

  validateApiToken(
    hash: string,
    now: Date,
    touchIntervalMs: number,
  ): Promise<AuthUser | null> {
    return this.transactions.run(async (transaction) => {
      const row = await transaction
        .selectFrom('iam.api_tokens as token')
        .innerJoin('iam.users as user', 'user.id', 'token.user_id')
        .select([
          'token.id as token_id',
          'token.last_used_at',
          'user.id',
          'user.numeric_id',
          'user.username',
          'user.password_hash',
          'user.display_name',
          'user.status',
          'user.auth_version',
          'user.authz_version',
          'user.created_at',
          'user.updated_at',
        ])
        .where('token.hash', '=', hash)
        .executeTakeFirst();
      if (!row || row.status !== 'active') return null;
      const elapsed = row.last_used_at
        ? now.getTime() - row.last_used_at.getTime()
        : Number.POSITIVE_INFINITY;
      if (elapsed >= touchIntervalMs) {
        const touched = await transaction
          .updateTable('iam.api_tokens')
          .set({ last_used_at: now })
          .where('id', '=', row.token_id)
          .where('hash', '=', hash)
          .executeTakeFirst();
        if (Number(touched.numUpdatedRows) !== 1) return null;
      }
      return this.toUser(row as UserRow & { token_id: string });
    });
  }

  createApiToken(
    userId: string,
    token: AuthApiToken,
    maximumTokens: number,
    onCreated?: AuthTransactionHook<AuthApiToken>,
  ): Promise<'created' | 'inactive-user' | 'capacity'> {
    return this.transactions.run(async (transaction) => {
      const user = await transaction
        .selectFrom('iam.users')
        .select(['id', 'status'])
        .where('id', '=', userId)
        .forUpdate()
        .executeTakeFirst();
      if (!user || user.status !== 'active') return 'inactive-user';
      const count = await transaction
        .selectFrom('iam.api_tokens')
        .select(sql<number>`count(*)::integer`.as('count'))
        .where('user_id', '=', userId)
        .executeTakeFirstOrThrow();
      if (count.count >= maximumTokens) return 'capacity';
      await transaction
        .insertInto('iam.api_tokens')
        .values({
          id: token.id,
          user_id: token.userId,
          name: token.name,
          hash: token.hash,
          last_used_at: token.lastUsedAt,
          created_at: token.createdAt,
        })
        .executeTakeFirstOrThrow();
      await onCreated?.(transaction, token);
      return 'created';
    });
  }

  async listApiTokens(userId: string): Promise<AuthApiToken[]> {
    const rows = await this.database
      .selectFrom('iam.api_tokens')
      .selectAll()
      .where('user_id', '=', userId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
    return rows.map((row) => this.toApiToken(row as ApiTokenRow));
  }

  deleteApiToken(
    userId: string,
    tokenId: string,
    onDeleted?: AuthTransactionHook<AuthApiToken>,
  ): Promise<AuthApiToken | null> {
    return this.transactions.run(async (transaction) => {
      const row = await transaction
        .deleteFrom('iam.api_tokens')
        .where('id', '=', tokenId)
        .where('user_id', '=', userId)
        .returningAll()
        .executeTakeFirst();
      if (!row) return null;
      const token = this.toApiToken(row as ApiTokenRow);
      await onDeleted?.(transaction, token);
      return token;
    });
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

  async deleteUserCredentials(
    transaction: IamTransaction,
    userId: string,
  ): Promise<void> {
    await transaction.deleteFrom('iam.refresh_tokens')
      .where('user_id', '=', userId)
      .execute();
    await transaction.deleteFrom('iam.api_tokens')
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
      authzVersion: String(row.authz_version),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toApiToken(row: ApiTokenRow): AuthApiToken {
    return {
      id: row.id,
      userId: row.user_id,
      name: row.name,
      hash: row.hash,
      lastUsedAt: row.last_used_at,
      createdAt: row.created_at,
    };
  }
}
