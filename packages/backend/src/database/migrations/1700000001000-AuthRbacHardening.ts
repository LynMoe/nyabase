import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds durable browser-session generations, bounded refresh-session rotation,
 * and stable built-in group identities without rewriting the released initial
 * migration.
 */
export class AuthRbacHardening1700000001000 implements MigrationInterface {
  name = 'AuthRbacHardening1700000001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN "authVersion" integer NOT NULL DEFAULT (0)`,
    );
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" ADD COLUMN "previousHash" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" ADD COLUMN "previousRequestIdHash" text`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_refresh_tokens_previous_hash" ON "refresh_tokens" ("previousHash") WHERE "previousHash" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_refresh_tokens_expires_at" ON "refresh_tokens" ("expiresAt")`,
    );

    // Old rotation rows have no family linkage and are never accepted again.
    // Drop unusable rows and trim every legacy user to the same bounded-session
    // invariant that the runtime enforces before accepting new logins.
    await queryRunner.query(
      `DELETE FROM "refresh_tokens"
       WHERE "revoked" = 1 OR julianday("expiresAt") <= julianday('now')`,
    );
    await queryRunner.query(
      `DELETE FROM "refresh_tokens"
       WHERE "id" IN (
         SELECT "id" FROM (
           SELECT "id", ROW_NUMBER() OVER (
             PARTITION BY "userId"
             ORDER BY julianday("createdAt") DESC, "createdAt" DESC, "id" DESC
           ) AS "sessionRank"
           FROM "refresh_tokens"
           WHERE "revoked" = 0
         ) AS "rankedRefreshTokens"
         WHERE "sessionRank" > 16
       )`,
    );

    await queryRunner.query(`ALTER TABLE "groups" ADD COLUMN "systemKey" text`);
    await queryRunner.query(
      `UPDATE "groups" SET "systemKey" = 'administrators' WHERE "name" = 'Administrators' AND "isSystem" = 1`,
    );
    await queryRunner.query(
      `UPDATE "groups" SET "systemKey" = 'operators' WHERE "name" = 'Operators' AND "isSystem" = 1`,
    );
    await queryRunner.query(
      `UPDATE "groups" SET "systemKey" = 'users' WHERE "name" = 'Users' AND "isSystem" = 1`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_groups_system_key" ON "groups" ("systemKey") WHERE "systemKey" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_groups_system_key"`);
    await queryRunner.query(`ALTER TABLE "groups" DROP COLUMN "systemKey"`);
    await queryRunner.query(`DROP INDEX "IDX_refresh_tokens_expires_at"`);
    await queryRunner.query(`DROP INDEX "IDX_refresh_tokens_previous_hash"`);
    await queryRunner.query(`ALTER TABLE "refresh_tokens" DROP COLUMN "previousRequestIdHash"`);
    await queryRunner.query(`ALTER TABLE "refresh_tokens" DROP COLUMN "previousHash"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "authVersion"`);
  }
}
