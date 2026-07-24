import { MigrationInterface, QueryRunner } from 'typeorm';

/** Adds the durable optimistic-concurrency token used by image admin writes. */
export class ProductRevisionCas1700000002000 implements MigrationInterface {
  name = 'ProductRevisionCas1700000002000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Existing rows deterministically become revision 1; new rows inherit the
    // same default until the application explicitly advances them.
    await queryRunner.query(
      `ALTER TABLE "images" ADD COLUMN "revision" integer NOT NULL DEFAULT (1)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "images" DROP COLUMN "revision"`);
  }
}
