import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Kysely, Transaction } from 'kysely';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import { asJsonObject } from './json.js';
import type { ExtensionClaimsPort, ExtensionHealthPort } from './types.js';

export type ExtensionExecutor = Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase>;

@Injectable()
export class ExtensionDeviceClaimsRepository {
  constructor(@Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>) {}

  for(
    extensionId: string,
    serverId: string,
    containerId: string,
    executor: ExtensionExecutor = this.database,
  ): ExtensionClaimsPort {
    return {
      replace: async (deviceKeys) => {
        await executor
          .deleteFrom('control.extension_device_claims')
          .where('container_id', '=', containerId)
          .where('extension_id', '=', extensionId)
          .execute();
        if (deviceKeys.length === 0) return;
        await executor
          .insertInto('control.extension_device_claims')
          .values(deviceKeys.map((deviceKey) => ({
            id: randomUUID(),
            extension_id: extensionId,
            server_id: serverId,
            container_id: containerId,
            device_key: deviceKey,
          })))
          .execute();
      },
      listOccupiedKeys: async (excludeContainerId = containerId) => {
        let query = executor
          .selectFrom('control.extension_device_claims')
          .select('device_key')
          .where('extension_id', '=', extensionId)
          .where('server_id', '=', serverId);
        if (excludeContainerId) {
          query = query.where('container_id', '!=', excludeContainerId);
        }
        const rows = await query.execute();
        return rows.map((row) => row.device_key);
      },
      count: async () => this.countForServerExtension(extensionId, serverId, executor),
    };
  }

  forServer(
    extensionId: string,
    serverId: string,
    executor: ExtensionExecutor = this.database,
  ): ExtensionClaimsPort {
    return {
      replace: async (deviceKeys) => {
        if (deviceKeys.length > 0) {
          throw new Error('server-scoped claims can only be cleared');
        }
        await executor
          .deleteFrom('control.extension_device_claims')
          .where('extension_id', '=', extensionId)
          .where('server_id', '=', serverId)
          .execute();
      },
      listOccupiedKeys: async () => {
        const rows = await executor
          .selectFrom('control.extension_device_claims')
          .select('device_key')
          .where('extension_id', '=', extensionId)
          .where('server_id', '=', serverId)
          .execute();
        return rows.map((row) => row.device_key);
      },
      count: async () => this.countForServerExtension(extensionId, serverId, executor),
    };
  }

  health(
    serverId: string,
    extensionId: string,
    executor: ExtensionExecutor = this.database,
  ): ExtensionHealthPort {
    return {
      read: async () => {
        const row = await executor
          .selectFrom('infra.server_extensions')
          .select('health')
          .where('server_id', '=', serverId)
          .where('extension_id', '=', extensionId)
          .executeTakeFirst();
        return asJsonObject(row?.health);
      },
      write: async (health) => {
        await executor
          .updateTable('infra.server_extensions')
          .set({ health })
          .where('server_id', '=', serverId)
          .where('extension_id', '=', extensionId)
          .execute();
      },
    };
  }

  async countForServerExtension(
    extensionId: string,
    serverId: string,
    executor: ExtensionExecutor = this.database,
  ): Promise<number> {
    const row = await executor
      .selectFrom('control.extension_device_claims')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('extension_id', '=', extensionId)
      .where('server_id', '=', serverId)
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  async countsForServer(
    serverId: string,
    executor: ExtensionExecutor = this.database,
  ): Promise<Map<string, number>> {
    const rows = await executor
      .selectFrom('control.extension_device_claims')
      .select('extension_id')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('server_id', '=', serverId)
      .groupBy('extension_id')
      .execute();
    return new Map(rows.map((row) => [row.extension_id, Number(row.count)]));
  }

  async listEnabledIds(
    serverId: string,
    executor: ExtensionExecutor = this.database,
  ): Promise<string[]> {
    const rows = await executor
      .selectFrom('infra.server_extensions')
      .select('extension_id')
      .where('server_id', '=', serverId)
      .where('enabled', '=', true)
      .execute();
    return rows.map((row) => row.extension_id);
  }

  async isEnabled(
    serverId: string,
    extensionId: string,
    executor: ExtensionExecutor = this.database,
  ): Promise<boolean> {
    const row = await executor
      .selectFrom('infra.server_extensions')
      .select('enabled')
      .where('server_id', '=', serverId)
      .where('extension_id', '=', extensionId)
      .executeTakeFirst();
    return row?.enabled === true;
  }

  async releaseContainerClaims(
    containerId: string,
    executor: ExtensionExecutor = this.database,
  ): Promise<void> {
    await executor
      .deleteFrom('control.extension_device_claims')
      .where('container_id', '=', containerId)
      .execute();
  }
}
