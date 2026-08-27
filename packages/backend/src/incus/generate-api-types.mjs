import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const INCUS_API_COMMIT = 'a1212093';
const schemaUrl = `https://raw.githubusercontent.com/lxc/incus/${INCUS_API_COMMIT}/doc/rest-api.yaml`;
const outputPath = resolve(dirname(fileURLToPath(import.meta.url)), 'api-types.ts');
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'nyabase-incus-'));
const convertedSchemaPath = join(temporaryDirectory, 'rest-api.openapi.json');

try {
  execFileSync(
    'pnpm',
    [
      'exec',
      'swagger2openapi',
      '--warnOnly',
      '--patch',
      '--fatal',
      '--resolve',
      '--outfile',
      convertedSchemaPath,
      schemaUrl,
    ],
    { cwd: workspaceRoot, stdio: 'inherit' },
  );
  const convertedSchema = JSON.parse(readFileSync(convertedSchemaPath, 'utf8'));
  const schemas = convertedSchema.components?.schemas;
  if (!schemas?.ConfigMap || !schemas?.DevicesMap) {
    throw new Error('Pinned Incus schema is missing ConfigMap or DevicesMap');
  }
  // The upstream Swagger schema omits additionalProperties for these named Go maps.
  schemas.ConfigMap.additionalProperties = { type: 'string' };
  schemas.DevicesMap.additionalProperties = {
    type: 'object',
    additionalProperties: { type: 'string' },
  };
  writeFileSync(convertedSchemaPath, JSON.stringify(convertedSchema));
  execFileSync('pnpm', ['exec', 'openapi-typescript', convertedSchemaPath, '-o', outputPath], {
    cwd: workspaceRoot,
    stdio: 'inherit',
  });
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
