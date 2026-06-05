import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDockerDaemonRuntimeObservations1780683300000 implements MigrationInterface {
  name = 'AddDockerDaemonRuntimeObservations1780683300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    const timestampType = isPostgres ? 'timestamp' : 'datetime';
    const falseDefault = isPostgres ? 'false' : '0';
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "docker_daemon_runtime_observations" (
        "server_id" text PRIMARY KEY NOT NULL,
        "state" text NOT NULL DEFAULT ('unknown'),
        "unit_file_in_sync" boolean NOT NULL DEFAULT ${falseDefault},
        "enabled" boolean NOT NULL DEFAULT ${falseDefault},
        "active" boolean NOT NULL DEFAULT ${falseDefault},
        "pid" integer,
        "docker_root" text NOT NULL,
        "socket_path" text NOT NULL,
        "server_version" text,
        "storage_driver" text,
        "last_error" text,
        "checked_at" ${timestampType} NOT NULL,
        "observed_at" ${timestampType} NOT NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_docker_daemon_checked_at" ON "docker_daemon_runtime_observations" ("checked_at")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_docker_daemon_observed_at" ON "docker_daemon_runtime_observations" ("observed_at")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_docker_daemon_observed_at"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_docker_daemon_checked_at"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "docker_daemon_runtime_observations"`);
  }
}
