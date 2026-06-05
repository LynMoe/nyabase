import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Baseline migration. Empty on purpose: existing deployments were initialised
 * via TypeORM `synchronize: true`, so they already match the entity schema.
 *
 * TODO(migrations):
 *   1. Run `pnpm --filter @nyabase/backend migration:generate -- \
 *        packages/backend/src/database/migrations/<Timestamp>-Baseline`
 *      against an empty database to capture the full schema in this file.
 *   2. Once captured, remove this comment and ship the SQL produced by TypeORM.
 *   3. Future schema changes MUST be added as new migration files; production
 *      runs with `synchronize: false` (see DatabaseModule).
 */
export class InitialSchema1700000000000 implements MigrationInterface {
  name = 'InitialSchema1700000000000';

  public async up(_queryRunner: QueryRunner): Promise<void> {
    // Intentionally empty. See TODO above.
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Intentionally empty. See TODO above.
  }
}
