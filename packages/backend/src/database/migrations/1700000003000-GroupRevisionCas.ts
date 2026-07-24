import { MigrationInterface, QueryRunner } from 'typeorm';

/** Adds the durable optimistic-concurrency token used by group metadata writes. */
export class GroupRevisionCas1700000003000 implements MigrationInterface {
  name = 'GroupRevisionCas1700000003000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "groups" ADD COLUMN "revision" integer NOT NULL DEFAULT (1)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "groups" DROP COLUMN "revision"`);
  }
}
