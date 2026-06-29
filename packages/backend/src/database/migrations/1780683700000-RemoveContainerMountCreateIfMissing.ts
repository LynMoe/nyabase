import type { MigrationInterface, QueryRunner } from 'typeorm';

const JSON_COLUMNS: Array<{ table: string; column: string; idColumn: string }> = [
  { table: 'container_desired_specs', column: 'mounts_json', idColumn: 'id' },
  { table: 'operations', column: 'request_json', idColumn: 'id' },
  { table: 'operations', column: 'payload_json', idColumn: 'id' },
  { table: 'operations', column: 'result_json', idColumn: 'id' },
  { table: 'operations', column: 'hook_plan_json', idColumn: 'id' },
  { table: 'operations', column: 'hook_results_json', idColumn: 'id' },
  { table: 'audit_logs', column: 'payload', idColumn: 'id' },
];

function cleanseLegacyMountCreate(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanseLegacyMountCreate);
  if (!value || typeof value !== 'object') return value;

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'createIfMissing' || key === 'createDirs') continue;
    result[key] = cleanseLegacyMountCreate(child);
  }
  return result;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (value.trim() === '') return value;
  return JSON.parse(value);
}

export class RemoveContainerMountCreateIfMissing1780683700000 implements MigrationInterface {
  name = 'RemoveContainerMountCreateIfMissing1780683700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    for (const spec of JSON_COLUMNS) {
      const table = await queryRunner.getTable(spec.table);
      if (!table?.findColumnByName(spec.column)) continue;
      const rows = await queryRunner.query(`SELECT "${spec.idColumn}" AS id, "${spec.column}" AS value FROM "${spec.table}" WHERE "${spec.column}" IS NOT NULL`);
      for (const row of rows as Array<{ id: string; value: unknown }>) {
        const original = parseJson(row.value);
        const cleansed = cleanseLegacyMountCreate(original);
        if (JSON.stringify(original) === JSON.stringify(cleansed)) continue;
        await queryRunner.query(
          isPostgres
            ? `UPDATE "${spec.table}" SET "${spec.column}" = $1 WHERE "${spec.idColumn}" = $2`
            : `UPDATE "${spec.table}" SET "${spec.column}" = ? WHERE "${spec.idColumn}" = ?`,
          [JSON.stringify(cleansed), row.id],
        );
      }
    }

    const mounts = await queryRunner.getTable('container_mounts');
    if (!mounts) return;
    for (const columnName of ['createIfMissing', 'create_if_missing']) {
      if (mounts.findColumnByName(columnName)) {
        await queryRunner.dropColumn(mounts, columnName);
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const mounts = await queryRunner.getTable('container_mounts');
    if (!mounts || mounts.findColumnByName('createIfMissing') || mounts.findColumnByName('create_if_missing')) return;
    await queryRunner.query('ALTER TABLE "container_mounts" ADD COLUMN "createIfMissing" boolean NOT NULL DEFAULT false');
  }
}
