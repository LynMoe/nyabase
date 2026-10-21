import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';

/**
 * Invalidation fence shared by authorization readers and post-commit intent
 * handlers. It deliberately contains no repositories.
 */
@Injectable()
export class AccessCacheEpochService {
  private value = 0;

  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
  ) {}

  current(): number {
    return this.value;
  }

  /**
   * Read the durable epoch before accepting an authorization cache hit;
   * PostgreSQL closes the stale window for changes this process did not bump.
   */
  async refresh(): Promise<number> {
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

  bump(): number {
    this.value += 1;
    return this.value;
  }
}
