import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
  Inject,
} from '@nestjs/common';
import { RedisDisposableAdapter } from '../runtime/redis-disposable.adapter.js';
import type { Kysely } from 'kysely';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';

/**
 * Process-local invalidation fence shared by authorization readers and
 * post-commit task finalizers. It deliberately contains no repositories, so
 * AgentTasksModule never needs to depend on AccessModule.
 */
@Injectable()
export class AccessCacheEpochService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AccessCacheEpochService.name);
  private value = 0;
  private unsubscribeRedis: (() => Promise<void>) | null = null;
  private redisSubscription: Promise<void> | null = null;
  private destroyed = false;

  constructor();
  constructor(database: Kysely<NyabaseDatabase>, redis?: RedisDisposableAdapter);
  constructor(
    @Optional()
    @Inject(PG_DATABASE)
    private readonly database?: Kysely<NyabaseDatabase>,
    @Optional()
    private readonly redis?: RedisDisposableAdapter,
  ) {}

  onModuleInit(): void {
    if (!this.redis) return;
    this.redisSubscription = this.redis.subscribe('cache-invalidation', (payload) => {
      if (this.destroyed) return;
      if (!payload.startsWith('access:')) return;
      const [, origin, rawEpoch] = payload.split(':');
      if (!origin || origin === this.redis?.gatewayId) return;
      const epoch = Number(rawEpoch);
      if (Number.isSafeInteger(epoch) && epoch >= 0) {
        if (epoch > this.value) this.value = epoch;
      } else {
        // Backward-compatible wake from an older process. PostgreSQL refresh
        // remains the durable source before any cache hit is accepted.
        this.bumpLocal();
      }
    }).then(async (unsubscribe) => {
      if (this.destroyed) {
        await unsubscribe();
        return;
      }
      this.unsubscribeRedis = unsubscribe;
    }).catch((error) => {
      this.logger.warn(
        `Access cache Redis subscription unavailable: ${errorMessage(error)}`,
      );
    }).finally(() => {
      this.redisSubscription = null;
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    await this.redisSubscription;
    await this.unsubscribeRedis?.();
    this.unsubscribeRedis = null;
  }

  current(): number {
    return this.value;
  }

  /**
   * Read the durable epoch before accepting an authorization cache hit.
   * Redis only shortens the stale window; PostgreSQL closes it across missed
   * publications, restarts, and `FLUSHALL`.
   */
  async refresh(): Promise<number> {
    if (!this.database) return this.value;
    const row = await this.database
      .selectFrom('iam.policy_state')
      .select('policy_epoch')
      .where('singleton', '=', true)
      .executeTakeFirstOrThrow();
    const value = Number(row.policy_epoch);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('IAM policy epoch exceeds the safe application range');
    }
    if (value > this.value) this.value = value;
    return this.value;
  }

  async refreshAndPublish(): Promise<number> {
    const value = await this.refresh();
    if (this.redis) {
      await this.redis.publish(
        'cache-invalidation',
        `access:${this.redis.gatewayId}:${value}`,
      );
    }
    return value;
  }

  bump(): number {
    const value = this.bumpLocal();
    if (this.redis) {
      void this.redis.publish(
        'cache-invalidation',
        `access:${this.redis.gatewayId}`,
      );
    }
    return value;
  }

  private bumpLocal(): number {
    this.value += 1;
    return this.value;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
