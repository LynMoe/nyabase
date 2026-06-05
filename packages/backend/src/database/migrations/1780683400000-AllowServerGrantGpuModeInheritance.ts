import { TableColumn, type MigrationInterface, type QueryRunner } from 'typeorm';

export class AllowServerGrantGpuModeInheritance1780683400000 implements MigrationInterface {
  name = 'AllowServerGrantGpuModeInheritance1780683400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('server_grants');
    if (!table) return;

    const column = table.findColumnByName('gpuMode') ?? table.findColumnByName('gpu_mode');
    if (!column || column.isNullable) return;

    await queryRunner.changeColumn(
      table,
      column,
      new TableColumn({
        ...column,
        isNullable: true,
        default: null,
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('server_grants');
    if (!table) return;

    const column = table.findColumnByName('gpuMode') ?? table.findColumnByName('gpu_mode');
    if (!column || !column.isNullable) return;

    await queryRunner.query(`UPDATE "server_grants" SET "${column.name}" = 'none' WHERE "${column.name}" IS NULL`);
    await queryRunner.changeColumn(
      table,
      column,
      new TableColumn({
        ...column,
        isNullable: false,
        default: "'none'",
      }),
    );
  }
}
