import { Inject, Injectable } from '@nestjs/common';
import { Capability, ContainerPhase, UserStatus } from '@nyabase/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { ExecSessionInfo } from './exec-session-registry.js';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';

/**
 * Re-validates a live console against one current PostgreSQL statement.
 *
 * Exec sessions are process-local, but their authority is not sticky: user
 * status, group capabilities, container identity, and the bound runtime all
 * remain durable Backend facts. Reading them in one statement prevents a
 * capability revocation from being hidden behind the access cache or a mix of
 * database snapshots.
 */
@Injectable()
export class ExecSessionAuthorizationService {
  constructor(
    @Inject(PG_DATABASE)
    private readonly database: Kysely<NyabaseDatabase>,
    private readonly transactions: PgTransactionManager,
  ) {}

  async isAuthorized(info: ExecSessionInfo, authVersion: number): Promise<boolean> {
    if (!Number.isInteger(authVersion) || authVersion < 0) return false;
    return this.queryAuthority(this.database, info, authVersion, false);
  }

  /**
   * Admission check used immediately before starting the Agent-side process.
   * The WebSocket later binds the session to one exact JWT generation, but an
   * unclaimed shell must not be started for authority that is already gone.
   */
  async isAuthorizedForAdmission(info: ExecSessionInfo): Promise<boolean> {
    return this.queryAuthority(this.database, info, null, false);
  }

  /**
   * Start a direct Agent side effect while a fresh credential/capability
   * snapshot owns the serialized DB lease. The returned RPC promise is boxed
   * so acknowledgement waiting happens after the read transaction commits;
   * dispatch itself occurs synchronously inside `start`.
   */
  async startAuthorized<T>(
    info: ExecSessionInfo,
    authVersion: number,
    start: () => Promise<T>,
    beforeStart?: (
      transaction: Transaction<NyabaseDatabase>,
    ) => Promise<void>,
  ): Promise<{ result: Promise<T> } | null> {
    if (!Number.isInteger(authVersion) || authVersion < 0) return null;
    const authorized = await this.transactions.run(async (transaction) => {
      if (!await this.queryAuthority(transaction, info, authVersion, true)) return null;
      await beforeStart?.(transaction);
      return true;
    });
    if (!authorized) return null;
    // Network dispatch starts only after authorization, audit, and durable
    // exec intent have committed together.
    return { result: start() };
  }

  private async queryAuthority(
    executor: Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase>,
    info: ExecSessionInfo,
    authVersion: number | null,
    lockForAdmission: boolean,
  ): Promise<boolean> {
    if (lockForAdmission) {
      await sql`
        SELECT 1
        FROM iam.policy_state
        WHERE singleton = true
        FOR UPDATE
      `.execute(executor);
    }
    const lock = lockForAdmission
      ? sql`FOR UPDATE OF container`
      : sql``;
    const result = await sql<{ allowed: number }>`
      SELECT 1 AS allowed
      FROM iam.policy_state AS policy
      JOIN iam.users AS "user" ON true
      JOIN control.containers AS container
        ON container.id = ${info.containerId}::uuid
      WHERE policy.singleton = true
        AND "user".id = ${info.userId}::uuid
        AND "user".status = ${UserStatus.Active}
        AND (${authVersion}::integer IS NULL OR "user".auth_version = ${authVersion})
        AND container.server_id = ${info.serverId}::uuid
        AND container.bound_runtime_id = ${info.dockerId}
        AND container.lifecycle_phase = ${ContainerPhase.Active}
        AND container.active_task_id IS NULL
        AND (
          (
            ${info.authorizationKind} = 'container-owner'
            AND container.owner_id = "user".id
            AND EXISTS (
              SELECT 1
              FROM iam.server_grants AS server_grant
              WHERE server_grant.server_id = container.server_id::text
                AND (
                  server_grant.user_id = "user".id
                  OR (
                    server_grant.group_id IS NOT NULL
                    AND EXISTS (
                      SELECT 1
                      FROM iam.group_members AS server_membership
                      WHERE server_membership.group_id = server_grant.group_id
                        AND server_membership.user_id = "user".id
                    )
                  )
                )
            )
          )
          OR (
            ${info.authorizationKind} = 'manage-containers-any'
            AND EXISTS (
              SELECT 1
              FROM iam.group_members AS membership
              JOIN iam.groups AS access_group
                ON access_group.id = membership.group_id
              WHERE membership.user_id = "user".id
                AND ${Capability.ManageContainersAny} = ANY(access_group.capabilities)
            )
          )
        )
      LIMIT 1
      ${lock}
    `.execute(executor);
    return result.rows.length === 1;
  }
}
