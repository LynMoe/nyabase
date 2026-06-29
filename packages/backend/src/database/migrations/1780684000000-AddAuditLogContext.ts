import type { MigrationInterface, QueryRunner } from 'typeorm';
import { TableColumn } from 'typeorm';

const COLUMNS = [
  new TableColumn({ name: 'actorName', type: 'text', isNullable: true }),
  new TableColumn({ name: 'actorUsername', type: 'text', isNullable: true }),
  new TableColumn({ name: 'actorSnapshot', type: 'text', isNullable: true }),
  new TableColumn({ name: 'targetName', type: 'text', isNullable: true }),
  new TableColumn({ name: 'targetSnapshot', type: 'text', isNullable: true }),
  new TableColumn({ name: 'related', type: 'text', isNullable: true }),
];

export class AddAuditLogContext1780684000000 implements MigrationInterface {
  name = 'AddAuditLogContext1780684000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('audit_logs');
    if (!table) return;

    for (const column of COLUMNS) {
      if (!table.findColumnByName(column.name)) {
        await queryRunner.addColumn(table, column);
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('audit_logs');
    if (!table) return;

    for (const column of [...COLUMNS].reverse()) {
      if (table.findColumnByName(column.name)) {
        await queryRunner.dropColumn(table, column.name);
      }
    }
  }
}
