import { Inject, Injectable } from '@nestjs/common';
import { UserStatus } from '@nyabase/common';
import type { Kysely } from 'kysely';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';

export interface RemoteFsCatalogItem {
  id: string;
  name: string;
  displayName: string | null;
  serverIds: string[];
}

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
      .select(['id', 'name', 'is_system'])
      .orderBy('priority', 'desc')
      .orderBy('name')
      .orderBy('id')
      .execute();
  }

  listServers() {
    return this.database
      .selectFrom('infra.servers')
      .select(['id', 'name', 'slug', 'status'])
      .orderBy('name')
      .orderBy('id')
      .execute();
  }

  listActiveImages() {
    return this.database
      .selectFrom('infra.images')
      .select(['id', 'name', 'description', 'is_active'])
      .where('is_active', '=', true)
      .where('deleting', '=', false)
      .orderBy('name')
      .orderBy('id')
      .execute();
  }

  async listActiveRemoteFsMounts(): Promise<RemoteFsCatalogItem[]> {
    const [mounts, assignments] = await Promise.all([
      this.database
        .selectFrom('infra.remote_fs_mounts')
        .select(['id', 'name', 'display_name'])
        .where('desired_state', '=', 'active')
        .orderBy('name')
        .orderBy('id')
        .execute(),
      this.database
        .selectFrom('infra.remote_fs_server_assignments')
        .select(['remote_fs_mount_id', 'server_id'])
        .where('desired_state', '=', 'active')
        .execute(),
    ]);
    const serverIdsByMount = new Map<string, string[]>();
    for (const assignment of assignments) {
      const ids = serverIdsByMount.get(assignment.remote_fs_mount_id) ?? [];
      ids.push(assignment.server_id);
      serverIdsByMount.set(assignment.remote_fs_mount_id, ids);
    }
    return mounts.map((mount) => ({
      id: mount.id,
      name: mount.name,
      displayName: mount.display_name,
      serverIds: (serverIdsByMount.get(mount.id) ?? []).sort(),
    }));
  }
}
