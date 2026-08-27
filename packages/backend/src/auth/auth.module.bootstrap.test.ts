import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withPostgresTestDatabase } from '../persistence-pg/postgres-test-harness.js';

const backendRoot = resolve(__dirname, '../..');
const compiledAppModule = join(backendRoot, 'dist', 'app.module.js');
const describeBootstrap = process.env.NYABASE_TEST_DATABASE_URL
  && existsSync(compiledAppModule)
  ? describe
  : describe.skip;

describeBootstrap('AppModule capability guard bootstrap', () => {
  it('instantiates the compiled AppModule and injects the real access resolver', async () => {
    await withPostgresTestDatabase(async ({ connectionString }) => {
      const configDirectory = mkdtempSync(join(tmpdir(), 'nyabase-auth-bootstrap-'));
      const configPath = join(configDirectory, 'config.yaml');
      writeFileSync(
        configPath,
        [
          'http:',
          '  proxyToken: bootstrap-http-proxy-token-0123456789abcdef',
          'ssh:',
          '  keyEncryptionSecret: bootstrap-ssh-key-secret-0123456789abcdef01234567',
          '  proxyToken: bootstrap-ssh-proxy-token-0123456789abcdef',
          '',
        ].join('\n'),
        { mode: 0o600 },
      );

      const previousEnvironment = new Map<string, string | undefined>([
        ['NYABASE_CONFIG_FILE', process.env.NYABASE_CONFIG_FILE],
        ['NODE_ENV', process.env.NODE_ENV],
        ['NYABASE_RUNTIME_ROLE', process.env.NYABASE_RUNTIME_ROLE],
        ['DATABASE_URL', process.env.DATABASE_URL],
        ['DB_MIGRATIONS_RUN', process.env.DB_MIGRATIONS_RUN],
        ['REDIS_URL', process.env.REDIS_URL],
        ['JWT_SECRET', process.env.JWT_SECRET],
        ['HTTP_PROXY_TOKEN', process.env.HTTP_PROXY_TOKEN],
        ['SSH_PROXY_TOKEN', process.env.SSH_PROXY_TOKEN],
        ['SSH_KEY_SECRET', process.env.SSH_KEY_SECRET],
      ]);
      process.env.NYABASE_CONFIG_FILE = configPath;
      process.env.NODE_ENV = 'test';
      process.env.NYABASE_RUNTIME_ROLE = 'api';
      process.env.DATABASE_URL = connectionString;
      process.env.DB_MIGRATIONS_RUN = 'false';
      process.env.REDIS_URL = 'redis://127.0.0.1:1/0';
      process.env.JWT_SECRET = 'bootstrap-test-jwt-secret-bootstrap-test-jwt-secret';
      delete process.env.HTTP_PROXY_TOKEN;
      delete process.env.SSH_PROXY_TOKEN;
      delete process.env.SSH_KEY_SECRET;

      try {
        const result = spawnSync(
          process.execPath,
          ['--input-type=module', '-e', compiledBootstrapProbe],
          {
            cwd: backendRoot,
            encoding: 'utf8',
            env: process.env,
            timeout: 120_000,
          },
        );
        const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
        expect(result.error, output).toBeUndefined();
        expect(result.status, output).toBe(0);
        expect(output).toContain('CAPABILITY_GUARD_RESOLVER_PASS');
      } finally {
        for (const [key, value] of previousEnvironment) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        rmSync(configDirectory, { recursive: true, force: true });
      }
    });
  });
});

const compiledBootstrapProbe = `
import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Capability } from '@nyabase/common';
import { AccessResolverService } from './dist/access/access-resolver.service.js';
import { AppModule } from './dist/app.module.js';
import { CAPS_KEY } from './dist/auth/decorators/require-caps.decorator.js';
import { CapabilitiesGuard } from './dist/auth/guards/capabilities.guard.js';

const app = await NestFactory.createApplicationContext(AppModule, {
  abortOnError: false,
  logger: false,
});
try {
  const resolver = app.get(AccessResolverService);
  const guard = app.get(CapabilitiesGuard);
  if (guard.accessResolver !== resolver) {
    throw new Error('CapabilitiesGuard did not receive the AccessResolverService instance');
  }

  const handler = function handler() {};
  Reflect.defineMetadata(CAPS_KEY, [Capability.ManageUsers], handler);
  const context = {
    getHandler: () => handler,
    getClass: () => class TestController {},
    switchToHttp: () => ({
      getRequest: () => ({
        originalUrl: '/api/admin/users',
        user: { id: '00000000-0000-4000-8000-000000000099' },
      }),
    }),
  };
  try {
    await guard.canActivate(context);
    throw new Error('CapabilitiesGuard unexpectedly allowed a user without capabilities');
  } catch (error) {
    if (!(error instanceof ForbiddenException)) throw error;
  }
  console.log('CAPABILITY_GUARD_RESOLVER_PASS');
} finally {
  await app.close();
}
`;
