import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadNyabaseConfig } from './nyabase-config-loader.js';
import { NyabaseConfigService } from './nyabase-config.service.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'nyabase-config-test-'));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('read-only deployment configuration', () => {
  it('uses defaults when the config file is missing', () => {
    const loaded = loadNyabaseConfig({
      NYABASE_CONFIG_FILE: '/tmp/nyabase-config-missing.yaml',
    });
    expect(loaded.fields['server.port']).toMatchObject({
      effectiveValue: 3001,
      source: 'default',
    });
  });

  it('applies YAML over defaults and env over YAML', () => {
    const dir = tempDir();
    const configFile = join(dir, 'config.yaml');
    writeFileSync(configFile, [
      'server:',
      '  port: 4000',
      'branding:',
      '  title: From YAML',
      '',
    ].join('\n'));
    const loaded = loadNyabaseConfig({
      NYABASE_CONFIG_FILE: configFile,
      PORT: '5000',
    });
    expect(loaded.fields['server.port']).toMatchObject({
      effectiveValue: 5000,
      source: 'env',
      yamlValue: 4000,
    });
    expect(loaded.fields['branding.title']).toMatchObject({
      effectiveValue: 'From YAML',
      source: 'yaml',
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects invalid deployment secrets and lifetimes', () => {
    const base = { NYABASE_CONFIG_FILE: '/tmp/nyabase-config-missing.yaml' };
    expect(() => loadNyabaseConfig({ ...base, JWT_SECRET: 'short' }))
      .toThrow(/JWT_SECRET|auth\.jwtSecret/i);
    expect(() => loadNyabaseConfig({ ...base, JWT_EXPIRES_IN: '25h' }))
      .toThrow(/JWT_EXPIRES_IN|jwtExpiresIn/i);
    expect(() => loadNyabaseConfig({
      ...base,
      ADMIN_INIT_PASSWORD: 'short',
    })).toThrow(/ADMIN_INIT_PASSWORD|adminInitPassword/i);
  });

  it('overlays only online-editable values without rewriting YAML or secrets', () => {
    const dir = tempDir();
    const configFile = join(dir, 'config.yaml');
    const yaml = [
      'server:',
      '  port: 4100',
      'branding:',
      '  title: Bootstrap title',
      'auth:',
      '  jwtSecret: a-production-secret-that-is-at-least-32-characters',
      '',
    ].join('\n');
    writeFileSync(configFile, yaml);
    vi.stubEnv('NYABASE_CONFIG_FILE', configFile);
    vi.stubEnv('JWT_SECRET', '');
    const service = new NyabaseConfigService();
    const bootstrap = service.bootstrapEditableValues();

    service.applyAuthoritativeSnapshot({
      revision: 7,
      snapshotToken: 'a'.repeat(64),
      values: {
        ...bootstrap,
        'branding.title': 'Database title',
      },
    });

    expect(service.get('branding.title')).toBe('Database title');
    expect(service.source('branding.title')).toBe('database');
    expect(service.get('server.port')).toBe(4100);
    expect(service.source('server.port')).toBe('yaml');
    expect(service.allFields().find((field) =>
      field.key === 'auth.jwtSecret')).toMatchObject({
      effectiveValue: '********',
      editable: false,
      source: 'yaml',
    });
    expect(readFileSync(configFile, 'utf8')).toBe(yaml);
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps environment overrides deployment-owned after a database reload', () => {
    vi.stubEnv('NYABASE_CONFIG_FILE', '/tmp/nyabase-config-missing.yaml');
    vi.stubEnv('NYABASE_BRAND_TITLE', 'Environment title');
    const service = new NyabaseConfigService();
    service.applyAuthoritativeSnapshot({
      revision: 2,
      snapshotToken: 'b'.repeat(64),
      values: {
        ...service.bootstrapEditableValues(),
        'branding.title': 'Database title',
      },
    });
    expect(service.get('branding.title')).toBe('Environment title');
    expect(service.source('branding.title')).toBe('env');
  });

  it('rejects divergent content at the same absolute revision', () => {
    const service = new NyabaseConfigService();
    const values = service.bootstrapEditableValues();
    service.applyAuthoritativeSnapshot({
      revision: 2,
      snapshotToken: 'c'.repeat(64),
      values,
    });
    expect(() => service.applyAuthoritativeSnapshot({
      revision: 2,
      snapshotToken: 'd'.repeat(64),
      values: { ...values, 'branding.title': 'divergent' },
    })).toThrow(/Conflicting PostgreSQL system settings snapshot/);
  });
});

describe('NyabaseConfigService production secrets and config file mode', () => {
  const jwtSecret = 'a-production-secret-that-is-at-least-32-characters';
  const keySecret = 'dedicated-ssh-key-encryption-secret-32ch';

  it('fails closed when ssh.keyEncryptionSecret is empty in production', () => {
    vi.stubEnv('NYABASE_CONFIG_FILE', '/tmp/nyabase-config-missing.yaml');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('JWT_SECRET', jwtSecret);
    vi.stubEnv('SSH_KEY_ENCRYPTION_SECRET', '');
    const service = new NyabaseConfigService();
    expect(() => service.validateProductionSecrets())
      .toThrow(/ssh\.keyEncryptionSecret/);
    expect(() => service.keyEncryptionSecret())
      .toThrow(/ssh\.keyEncryptionSecret/);
  });

  it('never returns auth.jwtSecret from keyEncryptionSecret in production', () => {
    const dir = tempDir();
    const configFile = writeProductionConfig(dir, jwtSecret, keySecret, 0o400);
    vi.stubEnv('NYABASE_CONFIG_FILE', configFile);
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('JWT_SECRET', '');
    vi.stubEnv('SSH_KEY_ENCRYPTION_SECRET', '');
    const service = new NyabaseConfigService();
    expect(() => service.validateProductionSecrets()).not.toThrow();
    expect(service.keyEncryptionSecret()).toBe(keySecret);
    rmSync(dir, { recursive: true, force: true });
  });

  it('may fall back to jwtSecret outside production', () => {
    vi.stubEnv('NYABASE_CONFIG_FILE', '/tmp/nyabase-config-missing.yaml');
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('JWT_SECRET', jwtSecret);
    vi.stubEnv('SSH_KEY_ENCRYPTION_SECRET', '');
    const service = new NyabaseConfigService();
    expect(service.keyEncryptionSecret()).toBe(jwtSecret);
  });

  it('rejects a group/other-readable production config file', () => {
    const dir = tempDir();
    const configFile = writeProductionConfig(dir, jwtSecret, keySecret, 0o644);
    vi.stubEnv('NYABASE_CONFIG_FILE', configFile);
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('JWT_SECRET', '');
    vi.stubEnv('SSH_KEY_ENCRYPTION_SECRET', '');
    const service = new NyabaseConfigService();
    expect(() => service.validateProductionSecrets()).toThrow(/chmod 0400/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('accepts a production config file mode 0400 owned by the process uid', () => {
    const dir = tempDir();
    const configFile = writeProductionConfig(dir, jwtSecret, keySecret, 0o400);
    vi.stubEnv('NYABASE_CONFIG_FILE', configFile);
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('JWT_SECRET', '');
    vi.stubEnv('SSH_KEY_ENCRYPTION_SECRET', '');
    const service = new NyabaseConfigService();
    expect(() => service.validateProductionSecrets()).not.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });
});

function writeProductionConfig(
  dir: string,
  jwtSecret: string,
  keySecret: string,
  mode: number,
): string {
  const configFile = join(dir, 'config.yaml');
  writeFileSync(configFile, [
    'auth:',
    `  jwtSecret: ${jwtSecret}`,
    'ssh:',
    `  keyEncryptionSecret: ${keySecret}`,
    '',
  ].join('\n'));
  chmodSync(configFile, mode);
  return configFile;
}
