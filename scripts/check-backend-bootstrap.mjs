#!/usr/bin/env node
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const backendRoot = join(repoRoot, 'packages', 'backend');
const requireFromBackend = createRequire(join(backendRoot, 'package.json'));
requireFromBackend('reflect-metadata');
const { NestFactory } = requireFromBackend('@nestjs/core');

const root = mkdtempSync(join(tmpdir(), 'nyabase-backend-bootstrap-'));
const previousCwd = process.cwd();
const configPath = join(root, 'config.yaml');
writeFileSync(configPath, [
  'runtime:',
  '  nodeEnv: test',
  'server:',
  '  port: 1',
  '  corsOrigin: ""',
  'auth:',
  '  jwtSecret: "bootstrap-jwt-secret-bootstrap-jwt-secret"',
  '  jwtExpiresIn: 15m',
  '  refreshTokenExpiresDays: 1',
  '  adminInitPassword: "bootstrap-password"',
  'database:',
  '  driver: sqlite',
  `  path: ${JSON.stringify(join(root, 'app.db'))}`,
  '  synchronize: false',
  '  migrationsRun: true',
  'metrics:',
  '  victoriaMetricsUrl: http://127.0.0.1:1',
  'http:',
  '  proxyToken: "bootstrap-http-token-bootstrap-http-token"',
  'ssh:',
  '  keyEncryptionSecret: "bootstrap-key-secret-bootstrap-key-secret"',
  '  proxyToken: "bootstrap-ssh-token-bootstrap-ssh-token"',
  '  proxyPublicHost: ""',
  '  proxyPublicPort: 2222',
  '  proxySnapshotStaleMs: 300000',
  '',
].join('\n'), { mode: 0o600 });

process.env.NYABASE_CONFIG_FILE = configPath;
process.chdir(backendRoot);
let app;
try {
  const { AppModule } = await import(pathToFileURL(join(backendRoot, 'dist', 'app.module.js')));
  app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
    abortOnError: false,
  });
  console.log('Backend compiled bootstrap PASS: module graph, providers, fresh migration, and lifecycle init');
} finally {
  await app?.close();
  process.chdir(previousCwd);
  rmSync(root, { recursive: true, force: true });
}
