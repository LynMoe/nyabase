import { TableColumn, type MigrationInterface, type QueryRunner } from 'typeorm';

const DEFAULT_OVERRIDES = '{"uid":0,"entrypoint":null,"cmd":null,"init":false}';

export class AddImageRuntimeOverrides1780683500000 implements MigrationInterface {
  name = 'AddImageRuntimeOverrides1780683500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const images = await queryRunner.getTable('images');
    if (images && !images.findColumnByName('runtime_overrides')) {
      await queryRunner.addColumn(images, new TableColumn({
        name: 'runtime_overrides',
        type: 'text',
        isNullable: false,
        default: `'${DEFAULT_OVERRIDES}'`,
      }));
      const uidColumn = images.findColumnByName('defaultUid') ?? images.findColumnByName('default_uid');
      if (uidColumn) {
        await queryRunner.query(
          `UPDATE "images" SET "runtime_overrides" = '{"uid":' || "${uidColumn.name}" || ',"entrypoint":null,"cmd":null,"init":false}'`,
        );
      }
    }

    const desiredSpecs = await queryRunner.getTable('container_desired_specs');
    if (desiredSpecs && !desiredSpecs.findColumnByName('image_runtime_overrides')) {
      await queryRunner.addColumn(desiredSpecs, new TableColumn({
        name: 'image_runtime_overrides',
        type: 'text',
        isNullable: false,
        default: `'${DEFAULT_OVERRIDES}'`,
      }));
      const uidColumn = desiredSpecs.findColumnByName('image_default_uid');
      if (uidColumn) {
        await queryRunner.query(
          `UPDATE "container_desired_specs" SET "image_runtime_overrides" = '{"uid":' || "${uidColumn.name}" || ',"entrypoint":null,"cmd":null,"init":false}'`,
        );
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const desiredSpecs = await queryRunner.getTable('container_desired_specs');
    if (desiredSpecs?.findColumnByName('image_runtime_overrides')) {
      await queryRunner.dropColumn(desiredSpecs, 'image_runtime_overrides');
    }

    const images = await queryRunner.getTable('images');
    if (images?.findColumnByName('runtime_overrides')) {
      await queryRunner.dropColumn(images, 'runtime_overrides');
    }
  }
}
