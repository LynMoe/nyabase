import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { IntentKind, IntentResourceType } from '@nyabase/common';
import type { Kysely } from 'kysely';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { IntentRepository } from './intent.repository.js';
import type { IntentRecord } from './intent.repository.js';

@Injectable()
export class ServerPreflightIntentService {
  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly intents: IntentRepository,
  ) {}

  async create(
    serverId: string,
    actorId: string,
    expectedRevision: number,
    poolId: string,
    probeAddress: string,
  ): Promise<IntentRecord> {
    const server = await this.database.selectFrom('infra.servers')
      .select(['revision'])
      .where('id', '=', serverId)
      .executeTakeFirst();
    if (!server) throw new NotFoundException('Server not found');
    if (Number(server.revision) !== expectedRevision) {
      throw new ConflictException({ code: 'REVISION_CONFLICT' });
    }
    const pool = await this.database.selectFrom('infra.storage_pools')
      .select(['incus_name', 'server_id', 'registered'])
      .where('id', '=', poolId)
      .executeTakeFirst();
    if (!pool || pool.server_id !== serverId || !pool.registered) {
      throw new ConflictException({ code: 'MISSING_STORAGE_POOL' });
    }
    return this.intents.createPending({
      kind: IntentKind.ServerPreflight,
      resourceType: IntentResourceType.Server,
      resourceId: serverId,
      serverId,
      requestedBy: actorId,
      targetGeneration: expectedRevision,
      request: {
        preflight: {
          probePoolName: pool.incus_name,
          probeAddress,
        },
      },
    });
  }
}
