import { Injectable } from '@nestjs/common';

/**
 * Process-local invalidation fence shared by authorization readers and
 * post-commit task finalizers. It deliberately contains no repositories, so
 * AgentTasksModule never needs to depend on AccessModule.
 */
@Injectable()
export class AccessCacheEpochService {
  private value = 0;

  current(): number {
    return this.value;
  }

  bump(): number {
    this.value += 1;
    return this.value;
  }
}
