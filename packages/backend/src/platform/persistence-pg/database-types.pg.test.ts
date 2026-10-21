import { dirname, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { withPostgresTestDatabase } from './postgres-test-harness.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

interface ColumnContract {
  column: string;
  nullable: boolean;
}

function hasNull(
  type: ts.Type,
  checker: ts.TypeChecker,
  location: ts.Node,
): boolean {
  if ((type.flags & ts.TypeFlags.Null) !== 0) return true;
  if (type.isUnion()) {
    return type.types.some((part) => hasNull(part, checker, location));
  }
  const selectType = type.getProperty('__select__');
  return selectType
    ? hasNull(
      checker.getTypeOfSymbolAtLocation(selectType, location),
      checker,
      location,
    )
    : false;
}

function databaseTypeContract(): Map<string, ColumnContract[]> {
  const configPath = ts.findConfigFile(__dirname, ts.sys.fileExists, 'tsconfig.json');
  if (!configPath) throw new Error('backend tsconfig.json was not found');
  const parsed = ts.parseJsonConfigFileContent(
    ts.readConfigFile(configPath, ts.sys.readFile).config,
    ts.sys,
    dirname(configPath),
  );
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();
  const databaseTypesPath = resolve(__dirname, 'database.types.ts');
  const source = program.getSourceFile(databaseTypesPath);
  if (!source) throw new Error('database.types.ts was not loaded');
  const declaration = source.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement)
      && statement.name.text === 'NyabaseDatabase',
  );
  if (!declaration) throw new Error('NyabaseDatabase interface was not found');

  const databaseType = checker.getTypeAtLocation(declaration);
  return new Map(checker.getPropertiesOfType(databaseType).map((tableSymbol) => {
    const tableType = checker.getTypeOfSymbolAtLocation(tableSymbol, declaration);
    const columns = checker.getPropertiesOfType(tableType)
      .map((columnSymbol) => {
        const columnType = checker.getTypeOfSymbolAtLocation(columnSymbol, declaration);
        return {
          column: columnSymbol.getName(),
          nullable: hasNull(columnType, checker, declaration),
        };
      })
      .sort((left, right) => left.column.localeCompare(right.column));
    return [tableSymbol.getName(), columns];
  }));
}

describePg('PostgreSQL runtime/type schema contract', () => {
  it('keeps every application table column and nullability aligned with Kysely types', async () => {
    const expected = databaseTypeContract();
    await withPostgresTestDatabase(async ({ database }) => {
      const catalog = await sql<{
        table_name: string;
        column_name: string;
        is_nullable: 'YES' | 'NO';
      }>`
        SELECT
          table_schema || '.' || table_name AS table_name,
          column_name,
          is_nullable
        FROM information_schema.columns
        WHERE table_schema IN (
          'audit',
          'control',
          'iam',
          'infra',
          'interaction',
          'system'
        )
        ORDER BY table_name, column_name
      `.execute(database);
      const actual = new Map<string, ColumnContract[]>();
      for (const row of catalog.rows) {
        const columns = actual.get(row.table_name) ?? [];
        columns.push({
          column: row.column_name,
          nullable: row.is_nullable === 'YES',
        });
        actual.set(row.table_name, columns);
      }

      expect(
        [...actual.keys()].sort(),
        'database types must cover every application table',
      ).toEqual([...expected.keys()].sort());
      for (const [table, columns] of actual) {
        expect(
          columns,
          `${table} columns/nullability drifted from its Kysely table type`,
        ).toEqual(expected.get(table));
      }
    });
  });

  it('keeps clean-cutover objects, UUID foreign keys, and critical guards in PostgreSQL', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const workflowSchema = await sql<{ exists: boolean }>`
        SELECT EXISTS (
          SELECT 1
          FROM pg_namespace
          WHERE nspname = 'workflow'
        ) AS exists
      `.execute(database);
      expect(workflowSchema.rows[0]?.exists).toBe(false);

      const requiredTables = await sql<{ table_name: string }>`
        SELECT table_schema || '.' || table_name AS table_name
        FROM information_schema.tables
        WHERE (table_schema, table_name) IN (
          ('infra', 'servers'),
          ('infra', 'ip_pools'),
          ('infra', 'ip_pool_servers'),
          ('infra', 'storage_pools'),
          ('infra', 'shared_backends'),
          ('infra', 'image_server_assignments'),
          ('control', 'containers'),
          ('control', 'volumes'),
          ('control', 'volume_attachments'),
          ('control', 'intents'),
          ('control', 'reconcile_claims'),
          ('iam', 'storage_pool_grants'),
          ('iam', 'shared_backend_grants'),
          ('system', 'incus_client_certificates'),
          ('system', 'incus_client_certificate_trusts')
        )
        ORDER BY table_name
      `.execute(database);
      expect(requiredTables.rows.map((row) => row.table_name)).toEqual([
        'control.containers',
        'control.intents',
        'control.reconcile_claims',
        'control.volume_attachments',
        'control.volumes',
        'iam.shared_backend_grants',
        'iam.storage_pool_grants',
        'infra.image_server_assignments',
        'infra.ip_pool_servers',
        'infra.ip_pools',
        'infra.servers',
        'infra.shared_backends',
        'infra.storage_pools',
        'system.incus_client_certificate_trusts',
        'system.incus_client_certificates',
      ]);

      const foreignKeyTypes = await sql<{ constraint_name: string }>`
        SELECT constraint_name
        FROM information_schema.referential_constraints AS constraints
        JOIN information_schema.key_column_usage AS child
          USING (constraint_catalog, constraint_schema, constraint_name)
        JOIN information_schema.columns AS child_columns
          ON child_columns.table_schema = child.table_schema
         AND child_columns.table_name = child.table_name
         AND child_columns.column_name = child.column_name
        JOIN information_schema.constraint_column_usage AS parent
          USING (constraint_catalog, constraint_schema, constraint_name)
        JOIN information_schema.columns AS parent_columns
          ON parent_columns.table_schema = parent.table_schema
         AND parent_columns.table_name = parent.table_name
         AND parent_columns.column_name = parent.column_name
        WHERE child_columns.data_type <> 'uuid'
           OR parent_columns.data_type <> 'uuid'
      `.execute(database);
      expect(foreignKeyTypes.rows).toEqual([]);

      const requiredIndexes = await sql<{ index_name: string }>`
        SELECT indexname AS index_name
        FROM pg_indexes
        WHERE schemaname IN ('control', 'iam', 'infra', 'system')
          AND indexname IN (
            'storage_pools_shared_backend_server_unique',
            'volumes_incus_name_key',
            'incus_client_certificates_active_unique',
            'server_grants_user_unique',
            'server_grants_group_unique',
            'storage_pool_grants_user_unique',
            'storage_pool_grants_group_unique',
            'shared_backend_grants_user_unique',
            'shared_backend_grants_group_unique'
          )
        ORDER BY index_name
      `.execute(database);
      expect(requiredIndexes.rows.map((row) => row.index_name)).toEqual([
        'incus_client_certificates_active_unique',
        'server_grants_group_unique',
        'server_grants_user_unique',
        'shared_backend_grants_group_unique',
        'shared_backend_grants_user_unique',
        'storage_pool_grants_group_unique',
        'storage_pool_grants_user_unique',
        'storage_pools_shared_backend_server_unique',
        'volumes_incus_name_key',
      ]);

      const requiredChecks = await sql<{ constraint_name: string }>`
        SELECT conname AS constraint_name
        FROM pg_constraint
        WHERE contype = 'c'
          AND conname IN (
            'storage_pools_filesystem_check',
            'storage_pools_shared_shape_check',
            'storage_pools_source_check',
            'volumes_scope_check',
            'intents_settled_shape_check',
            'intents_failure_shape_check',
            'authorization_dependencies_shape_check'
          )
        ORDER BY constraint_name
      `.execute(database);
      expect(requiredChecks.rows.map((row) => row.constraint_name)).toEqual([
        'authorization_dependencies_shape_check',
        'intents_failure_shape_check',
        'intents_settled_shape_check',
        'storage_pools_filesystem_check',
        'storage_pools_shared_shape_check',
        'storage_pools_source_check',
        'volumes_scope_check',
      ]);
    });
  });
});
