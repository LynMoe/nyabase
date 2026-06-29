import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddHttpProxyModel1780684100000 implements MigrationInterface {
  name = 'AddHttpProxyModel1780684100000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "http_domain_pools" (
        "id" text PRIMARY KEY NOT NULL,
        "wildcard_domain" text NOT NULL,
        "enabled" boolean NOT NULL DEFAULT (1),
        "https_enabled" boolean NOT NULL DEFAULT (0),
        "certificate_pem" text,
        "encrypted_private_key_pem" text,
        "certificate_fingerprint" text,
        "certificate_not_after" datetime,
        "created_at" datetime NOT NULL DEFAULT (datetime('now')),
        "updated_at" datetime NOT NULL DEFAULT (datetime('now'))
      )
    `);
    await queryRunner.query('CREATE UNIQUE INDEX "IDX_http_domain_pools_wildcard_domain" ON "http_domain_pools" ("wildcard_domain")');
    await queryRunner.query(`
      CREATE TABLE "http_proxy_bindings" (
        "id" text PRIMARY KEY NOT NULL,
        "hostname" text NOT NULL,
        "domain_pool_id" text NOT NULL,
        "owner_id" text NOT NULL,
        "container_id" text NOT NULL,
        "target_port" integer NOT NULL,
        "target_protocol" text NOT NULL DEFAULT ('http'),
        "created_at" datetime NOT NULL DEFAULT (datetime('now')),
        "updated_at" datetime NOT NULL DEFAULT (datetime('now'))
      )
    `);
    await queryRunner.query('CREATE UNIQUE INDEX "IDX_http_proxy_bindings_hostname" ON "http_proxy_bindings" ("hostname")');
    await queryRunner.query('CREATE INDEX "IDX_http_proxy_bindings_domain_pool_id" ON "http_proxy_bindings" ("domain_pool_id")');
    await queryRunner.query('CREATE INDEX "IDX_http_proxy_bindings_owner_id" ON "http_proxy_bindings" ("owner_id")');
    await queryRunner.query('CREATE INDEX "IDX_http_proxy_bindings_container_id" ON "http_proxy_bindings" ("container_id")');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "IDX_http_proxy_bindings_container_id"');
    await queryRunner.query('DROP INDEX "IDX_http_proxy_bindings_owner_id"');
    await queryRunner.query('DROP INDEX "IDX_http_proxy_bindings_domain_pool_id"');
    await queryRunner.query('DROP INDEX "IDX_http_proxy_bindings_hostname"');
    await queryRunner.query('DROP TABLE "http_proxy_bindings"');
    await queryRunner.query('DROP INDEX "IDX_http_domain_pools_wildcard_domain"');
    await queryRunner.query('DROP TABLE "http_domain_pools"');
  }
}
