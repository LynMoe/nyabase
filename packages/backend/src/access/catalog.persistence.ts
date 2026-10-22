import { Inject, Injectable } from '@nestjs/common';
import { UserStatus } from '@nyabase/common';
import type { Kysely } from 'kysely';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';

@Injectable()
export class CatalogPersistence {
  constructor(
    @Inject(PG_DATABASE)
    private readonly database: Kysely<NyabaseDatabase>,
  ) {}

  listUsers() {
    return this.database
      .selectFrom('iam.users')
      .select(['id', 'username', 'display_name', 'status'])
      .where('status', '!=', UserStatus.Deleted)
      .orderBy('username')
      .orderBy('id')
      .execute();
  }

  listGroups() {
    return this.database
      .selectFrom('iam.groups')
      .select(['id', 'name'])
      .orderBy('name')
      .orderBy('id')
      .execute();
  }

  listServers() {
    return this.database
      .selectFrom('infra.servers')
      .select([
        'id',
        'name',
        'slug',
        'status',
        'preflight_status',
        'gpu_enabled',
      ])
      .orderBy('name')
      .orderBy('id')
      .execute();
  }
}
