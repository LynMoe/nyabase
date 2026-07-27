import { Global, Module } from '@nestjs/common';
import { parseRedisConnectionUrl } from '@nyabase/common';
import { createClient, type RedisClientType } from 'redis';
import { readFile } from 'node:fs/promises';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';
import {
  DISPOSABLE_REDIS_CLIENT,
  RedisDisposableAdapter,
} from './redis-disposable.adapter.js';

@Global()
@Module({
  providers: [
    {
      provide: DISPOSABLE_REDIS_CLIENT,
      inject: [NyabaseConfigService],
      useFactory: async (
        config: NyabaseConfigService,
      ): Promise<RedisClientType> => createClient(
        await redisClientOptions(config),
      ) as RedisClientType,
    },
    RedisDisposableAdapter,
  ],
  exports: [RedisDisposableAdapter],
})
export class RedisRuntimeModule {}

export async function redisClientOptions(
  config: NyabaseConfigService,
): Promise<NonNullable<Parameters<typeof createClient>[0]>> {
  const url = config.get<string>('redis.url');
  const caFile = config.get<string>('redis.tlsCaFile');
  const servername = config.get<string>('redis.tlsServername');
  // Revalidate here as a defense-in-depth boundary: callers and tests can
  // construct NyabaseConfigService-like objects without going through Zod.
  const parsedUrl = parseRedisConnectionUrl(url);
  const tls = parsedUrl.protocol === 'rediss:';
  if (!tls && (caFile || servername)) {
    throw new Error(
      'redis.tlsCaFile and redis.tlsServername require a rediss:// URL',
    );
  }
  const ca = caFile ? await readFile(caFile, 'utf8') : undefined;
  return {
    url,
    // Avoid granting the application broad CLIENT subcommands merely for the
    // optional node-redis SETINFO handshake.
    disableClientInfo: true,
    socket: tls
      ? {
          tls: true,
          ca,
          servername: servername || undefined,
          rejectUnauthorized: true,
          connectTimeout: 1_000,
          reconnectStrategy: false,
        }
      : {
          connectTimeout: 1_000,
          reconnectStrategy: false,
        },
  };
}
