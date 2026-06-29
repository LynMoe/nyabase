import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableIndex, TableUnique } from 'typeorm';

export class RebuildLightweightOperations1780683800000 implements MigrationInterface {
  name = 'RebuildLightweightOperations1780683800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('agent_command_outbox', true);
    await queryRunner.dropTable('operation_steps', true);
    await queryRunner.dropTable('reconcile_tasks', true);
    await queryRunner.dropTable('resource_locks', true);
    await queryRunner.dropTable('operations', true);

    await queryRunner.createTable(new Table({
      name: 'operations',
      columns: [
        { name: 'id', type: 'text', isPrimary: true },
        { name: 'kind', type: 'text' },
        { name: 'server_id', type: 'text' },
        { name: 'resource_type', type: 'text' },
        { name: 'resource_id', type: 'text' },
        { name: 'requested_by', type: 'text', isNullable: true },
        { name: 'command_id', type: 'text' },
        { name: 'command_kind', type: 'text' },
        { name: 'resource_keys_json', type: 'text' },
        { name: 'unlock_report_kind', type: 'text', isNullable: true },
        { name: 'request_json', type: 'text', isNullable: true },
        { name: 'payload_json', type: 'text', isNullable: true },
        { name: 'hook_plan_json', type: 'text' },
        { name: 'hook_results_json', type: 'text' },
        { name: 'status', type: 'text', default: "'queued'" },
        { name: 'result_json', type: 'text', isNullable: true },
        { name: 'last_error', type: 'text', isNullable: true },
        { name: 'created_at', type: 'datetime', default: "datetime('now')" },
        { name: 'started_at', type: 'datetime', isNullable: true },
        { name: 'command_completed_at', type: 'datetime', isNullable: true },
        { name: 'completed_at', type: 'datetime', isNullable: true },
      ],
      uniques: [new TableUnique({ columnNames: ['command_id'] })],
    }), true);

    for (const columnName of [
      'kind',
      'server_id',
      'resource_type',
      'resource_id',
      'requested_by',
      'status',
      'completed_at',
    ]) {
      await queryRunner.createIndex('operations', new TableIndex({
        columnNames: [columnName],
      }));
    }

    await queryRunner.createTable(new Table({
      name: 'resource_locks',
      columns: [
        { name: 'resource_key', type: 'text', isPrimary: true },
        { name: 'operation_id', type: 'text' },
        { name: 'server_id', type: 'text' },
        { name: 'created_at', type: 'datetime', default: "datetime('now')" },
        { name: 'updated_at', type: 'datetime', default: "datetime('now')" },
      ],
    }), true);
    await queryRunner.createIndex('resource_locks', new TableIndex({ columnNames: ['operation_id'] }));
    await queryRunner.createIndex('resource_locks', new TableIndex({ columnNames: ['server_id'] }));

    const lifecycle = await queryRunner.getTable('container_lifecycle');
    if (lifecycle?.findColumnByName('runtime_confirmation')) {
      await queryRunner.dropColumn(lifecycle, 'runtime_confirmation');
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('resource_locks', true);
    await queryRunner.dropTable('operations', true);
  }
}
