import { Injectable } from '@nestjs/common';
import { Capability, ContainerPhase, UserStatus } from '@nyabase/common';
import { DataSource } from 'typeorm';
import type { ExecSessionInfo } from './exec-session-registry.js';

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

  async isAuthorized(info: ExecSessionInfo): Promise<boolean> {
    const rows = await this.dataSource.query(
      `SELECT 1 AS allowed
       FROM users AS user
       JOIN containers AS container ON container.id = ?
       JOIN container_lifecycle AS lifecycle
         ON lifecycle.container_id = container.id
       WHERE user.id = ?
         AND user.status = ?
         AND container.server_id = ?
         AND lifecycle.bound_runtime_id = ?
         AND lifecycle.phase = ?
         AND lifecycle.active_task_id IS NULL
         AND (
           (? = 'container-owner' AND container.owner_id = user.id)
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
