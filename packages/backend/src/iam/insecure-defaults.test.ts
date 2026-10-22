import { afterEach, describe, expect, it, vi } from 'vitest';
import { NyabaseConfigService } from '../platform/config/nyabase-config.service.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

function startWith(env: Record<string, string | undefined>): NyabaseConfigService {
  vi.stubEnv('NYABASE_CONFIG_FILE', '/tmp/nyabase-config-missing.yaml');
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const config = new NyabaseConfigService();
  config.onModuleInit();
  return config;
}

describe('insecure development defaults need an explicit NODE_ENV', () => {
  it('refuses to start without secrets when NODE_ENV is unset', () => {
    expect(() => startWith({ NODE_ENV: undefined, JWT_SECRET: undefined, SSH_KEY_ENCRYPTION_SECRET: undefined }))
      .toThrow(/auth\.jwtSecret/);
    expect(() => startWith({
      NODE_ENV: undefined,
      JWT_SECRET: 'a-real-secret-that-is-at-least-32-characters',
      SSH_KEY_ENCRYPTION_SECRET: undefined,
    })).toThrow(/ssh\.keyEncryptionSecret/);
  });

  it.each(['development', 'test'])('allows the development fallbacks for NODE_ENV=%s', (nodeEnv) => {
    const config = startWith({ NODE_ENV: nodeEnv, JWT_SECRET: undefined, SSH_KEY_ENCRYPTION_SECRET: undefined });
    expect(config.get('runtime.nodeEnv')).toBe(nodeEnv);
    expect(config.get('auth.jwtSecret')).toBe('change-me-in-production');
  });
});
