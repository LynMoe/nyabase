import { describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import type { NyabaseConfigService } from '../config/nyabase-config.service.js';
import { redisClientOptions } from './redis-runtime.module.js';

function config(values: Record<string, string>): NyabaseConfigService {
  return {
    get: vi.fn((key: string) => values[key] ?? ''),
  } as unknown as NyabaseConfigService;
}

describe('redisClientOptions', () => {
  it('keeps plaintext local Redis free of TLS-only options', async () => {
    await expect(redisClientOptions(config({
      'redis.url': 'redis://redis:6379/0',
    }))).resolves.toMatchObject({
      url: 'redis://redis:6379/0',
      disableClientInfo: true,
      socket: {
        connectTimeout: 1_000,
        reconnectStrategy: false,
      },
    });
  });

  it('loads a private CA and always verifies rediss certificates', async () => {
    await expect(redisClientOptions(config({
      'redis.url': 'rediss://redis.internal:6379/0',
      'redis.tlsCaFile': resolve(
        process.cwd(),
        'src/runtime/redis-runtime.module.test.ts',
      ),
      'redis.tlsServername': 'redis.internal',
    }))).resolves.toMatchObject({
      disableClientInfo: true,
      socket: {
        tls: true,
        ca: expect.stringContaining('redisClientOptions'),
        servername: 'redis.internal',
        rejectUnauthorized: true,
      },
    });
  });

  it('rejects TLS-only settings on a plaintext Redis URL', async () => {
    await expect(redisClientOptions(config({
      'redis.url': 'redis://redis:6379/0',
      'redis.tlsCaFile': '/run/secrets/redis-ca.pem',
    }))).rejects.toThrow('require a rediss:// URL');
  });

  it.each([
    'redis:///0',
    'redis://redis',
    'redis://redis/01',
    'redis://redis/0/extra',
    'redis://user@redis/0',
    'redis://redis/0?tls=true',
    'rediss://redis/0?rejectUnauthorized=false',
  ])('revalidates and rejects unsafe Redis URL %s before createClient', async (url) => {
    await expect(redisClientOptions(config({
      'redis.url': url,
    }))).rejects.toThrow('Invalid Redis connection URL');
  });
});
