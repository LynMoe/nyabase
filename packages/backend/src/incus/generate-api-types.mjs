import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { upgrade } from '@scalar/openapi-upgrader';
import { parse } from 'yaml';

const INCUS_API_COMMIT = 'a1212093';
const schemaUrl = `https://raw.githubusercontent.com/lxc/incus/${INCUS_API_COMMIT}/doc/rest-api.yaml`;
const outputPath = resolve(dirname(fileURLToPath(import.meta.url)), 'api-types.ts');
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'nyabase-incus-'));
const convertedSchemaPath = join(temporaryDirectory, 'rest-api.openapi.json');

try {
  const response = await fetch(schemaUrl);
  if (!response.ok) throw new Error(`GET ${schemaUrl}: ${response.status}`);
  // Incus publishes Swagger 2.0; openapi-typescript reads OpenAPI 3.
  const convertedSchema = upgrade(parse(await response.text()), '3.0');
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
