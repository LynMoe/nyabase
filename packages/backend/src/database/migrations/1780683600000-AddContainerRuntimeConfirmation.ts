import { TableColumn, type MigrationInterface, type QueryRunner } from 'typeorm';

export class AddContainerRuntimeConfirmation1780683600000 implements MigrationInterface {
  name = 'AddContainerRuntimeConfirmation1780683600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('container_lifecycle');
    if (!table || table.findColumnByName('runtime_confirmation')) return;

    await queryRunner.addColumn(table, new TableColumn({
      name: 'runtime_confirmation',
      type: 'text',
      isNullable: true,
    }));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('container_lifecycle');
    if (table?.findColumnByName('runtime_confirmation')) {
      await queryRunner.dropColumn(table, 'runtime_confirmation');
    }
  }
}
