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
          'system',
          'workflow'
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
});
