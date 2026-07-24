import { Injectable } from '@nestjs/common';
import { Capability, ContainerPhase, UserStatus } from '@nyabase/common';
import { DataSource, type EntityManager } from 'typeorm';
import type { ExecSessionInfo } from './exec-session-registry.js';
import { runSerializedTransaction } from '../database/serialized-transaction.js';

/**
 * Re-validates a live console against one current SQLite statement.
 *
 * Exec sessions are process-local, but their authority is not sticky: user
 * status, group capabilities, container identity, and the bound runtime all
 * remain durable Backend facts. Reading them in one statement prevents a
 * capability revocation from being hidden behind the access cache or a mix of
 * database snapshots.
 */
@Injectable()
export class ExecSessionAuthorizationService {
  constructor(private readonly dataSource: DataSource) {}

  async isAuthorized(info: ExecSessionInfo, authVersion: number): Promise<boolean> {
    if (!Number.isInteger(authVersion) || authVersion < 0) return false;
    return this.queryAuthority(this.dataSource, info, authVersion);
  }

  /**
   * Admission check used immediately before starting the Agent-side process.
   * The WebSocket later binds the session to one exact JWT generation, but an
   * unclaimed shell must not be started for authority that is already gone.
   */
  async isAuthorizedForAdmission(info: ExecSessionInfo): Promise<boolean> {
    return this.queryAuthority(this.dataSource, info, null);
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
  ): Promise<{ result: Promise<T> } | null> {
    if (!Number.isInteger(authVersion) || authVersion < 0) return null;
    return runSerializedTransaction(this.dataSource, async (manager) => {
      if (!await this.queryAuthority(manager, info, authVersion)) return null;
      return { result: start() };
    });
  }

  private async queryAuthority(
    executor: Pick<DataSource | EntityManager, 'query'>,
    info: ExecSessionInfo,
    authVersion: number | null,
  ): Promise<boolean> {
    const rows = await executor.query(
      `SELECT 1 AS allowed
       FROM users AS user
       JOIN containers AS container ON container.id = ?
       JOIN container_lifecycle AS lifecycle
         ON lifecycle.container_id = container.id
       WHERE user.id = ?
         AND user.status = ?
         AND (? IS NULL OR user.authVersion = ?)
         AND container.server_id = ?
         AND lifecycle.bound_runtime_id = ?
         AND lifecycle.phase = ?
         AND lifecycle.active_task_id IS NULL
         AND (
           (? = 'container-owner'
             AND container.owner_id = user.id
             AND EXISTS (
               SELECT 1
               FROM server_grants AS server_grant
               WHERE server_grant.serverId = container.server_id
                 AND (
                   (server_grant.scope = 'user' AND server_grant.scopeId = user.id)
                   OR
                   (server_grant.scope = 'group' AND EXISTS (
                     SELECT 1
                     FROM group_members AS server_membership
                     WHERE server_membership.groupId = server_grant.scopeId
                       AND server_membership.userId = user.id
                   ))
                 )
             ))
           OR
           (? = 'manage-containers-any' AND EXISTS (
             SELECT 1
             FROM group_members AS membership
             JOIN groups AS access_group ON access_group.id = membership.groupId
             JOIN json_each(
               CASE
                 WHEN json_valid(access_group.capabilitiesJson) = 1
                 THEN access_group.capabilitiesJson
                 ELSE '[]'
               END
             ) AS capability
             WHERE membership.userId = user.id
               AND capability.value = ?
           ))
         )
       LIMIT 1`,
      [
        info.containerId,
        info.userId,
        UserStatus.Active,
        authVersion,
        authVersion,
        info.serverId,
        info.dockerId,
        ContainerPhase.Active,
        info.authorizationKind,
        info.authorizationKind,
        Capability.ManageContainersAny,
      ],
    ) as unknown;
    return Array.isArray(rows) && rows.length === 1;
  }
}
