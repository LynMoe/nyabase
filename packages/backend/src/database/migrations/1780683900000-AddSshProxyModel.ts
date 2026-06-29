import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableColumn, TableIndex } from 'typeorm';

function slugify(value: string, fallback: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return slug || fallback;
}

export class AddSshProxyModel1780683900000 implements MigrationInterface {
  name = 'AddSshProxyModel1780683900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const servers = await queryRunner.getTable('servers');
    if (servers) {
      for (const unique of servers.uniques.filter((entry) => entry.columnNames.length === 1 && entry.columnNames[0] === 'name')) {
        await queryRunner.dropUniqueConstraint('servers', unique);
      }
      for (const index of servers.indices.filter((entry) => entry.isUnique && entry.columnNames.length === 1 && entry.columnNames[0] === 'name')) {
        await queryRunner.dropIndex('servers', index);
      }
    }
    if (servers && !servers.findColumnByName('slug')) {
      await queryRunner.addColumn('servers', new TableColumn({
        name: 'slug',
        type: 'text',
        isNullable: true,
      }));
      const rows = await queryRunner.query('SELECT id, name FROM "servers"') as Array<{ id: string; name: string }>;
      const used = new Set<string>();
      for (const row of rows) {
        const base = slugify(row.name, `server-${row.id.slice(0, 8).toLowerCase()}`);
        let slug = base;
        let suffix = 2;
        while (used.has(slug)) {
          slug = `${base}-${suffix}`;
          suffix += 1;
        }
        used.add(slug);
        await queryRunner.query('UPDATE "servers" SET "slug" = ? WHERE "id" = ?', [slug, row.id]);
      }
      await queryRunner.changeColumn(
        'servers',
        'slug',
        new TableColumn({ name: 'slug', type: 'text', isNullable: false }),
      );
      await queryRunner.createIndex('servers', new TableIndex({
        name: 'IDX_servers_slug_unique',
        columnNames: ['slug'],
        isUnique: true,
      }));
    }

    const images = await queryRunner.getTable('images');
    if (images && !images.findColumnByName('disable_ssh')) {
      await queryRunner.addColumn(images, new TableColumn({
        name: 'disable_ssh',
        type: 'boolean',
        isNullable: false,
        default: false,
      }));
    }

    const desiredSpecs = await queryRunner.getTable('container_desired_specs');
    if (desiredSpecs?.findColumnByName('ssh_enabled')) {
      await queryRunner.dropColumn(desiredSpecs, 'ssh_enabled');
    }

    await queryRunner.createTable(new Table({
      name: 'user_internal_ssh_keys',
      columns: [
        { name: 'user_id', type: 'text', isPrimary: true },
        { name: 'encrypted_private_key', type: 'text' },
        { name: 'public_key', type: 'text' },
        { name: 'fingerprint', type: 'text' },
        { name: 'generation', type: 'int', default: 1 },
        { name: 'rotated_at', type: 'datetime' },
      ],
    }), true);
    await queryRunner.createIndex('user_internal_ssh_keys', new TableIndex({
      name: 'IDX_user_internal_ssh_keys_fingerprint',
      columnNames: ['fingerprint'],
    }));

    await queryRunner.createTable(new Table({
      name: 'ssh_proxy_host_keys',
      columns: [
        { name: 'id', type: 'text', isPrimary: true },
        { name: 'encrypted_private_key', type: 'text' },
        { name: 'public_key', type: 'text' },
        { name: 'fingerprint', type: 'text' },
        { name: 'generation', type: 'int', default: 1 },
        { name: 'rotated_at', type: 'datetime' },
      ],
    }), true);

    await queryRunner.createTable(new Table({
      name: 'ssh_proxy_tokens',
      columns: [
        { name: 'id', type: 'text', isPrimary: true },
        { name: 'token_hash', type: 'text' },
        { name: 'created_at', type: 'datetime' },
      ],
    }), true);

    await queryRunner.createTable(new Table({
      name: 'container_ssh_routes',
      columns: [
        { name: 'container_id', type: 'text', isPrimary: true },
        { name: 'server_id', type: 'text' },
        { name: 'runtime_id', type: 'text' },
        { name: 'macvlan_ip', type: 'text', isNullable: true },
        { name: 'runtime_status', type: 'text' },
        { name: 'ssh_status', type: 'text' },
        { name: 'applied_internal_key_generation', type: 'int', isNullable: true },
        { name: 'container_host_key_fingerprint', type: 'text', isNullable: true },
        { name: 'last_error', type: 'text', isNullable: true },
        { name: 'observed_at', type: 'datetime' },
      ],
    }), true);
    await queryRunner.createIndex('container_ssh_routes', new TableIndex({
      name: 'IDX_container_ssh_routes_server_id',
      columnNames: ['server_id'],
    }));
    await queryRunner.createIndex('container_ssh_routes', new TableIndex({
      name: 'IDX_container_ssh_routes_observed_at',
      columnNames: ['observed_at'],
    }));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('container_ssh_routes', true);
    await queryRunner.dropTable('ssh_proxy_tokens', true);
    await queryRunner.dropTable('ssh_proxy_host_keys', true);
    await queryRunner.dropTable('user_internal_ssh_keys', true);

    const desiredSpecs = await queryRunner.getTable('container_desired_specs');
    if (desiredSpecs && !desiredSpecs.findColumnByName('ssh_enabled')) {
      await queryRunner.addColumn(desiredSpecs, new TableColumn({
        name: 'ssh_enabled',
        type: 'boolean',
        isNullable: false,
        default: false,
      }));
    }

    const images = await queryRunner.getTable('images');
    if (images?.findColumnByName('disable_ssh')) {
      await queryRunner.dropColumn(images, 'disable_ssh');
    }

    const servers = await queryRunner.getTable('servers');
    if (servers?.findColumnByName('slug')) {
      const index = servers.indices.find((idx) => idx.name === 'IDX_servers_slug_unique');
      if (index) await queryRunner.dropIndex('servers', index);
      await queryRunner.dropColumn(servers, 'slug');
    }
  }
}
