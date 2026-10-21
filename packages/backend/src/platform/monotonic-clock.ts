import { Injectable } from '@nestjs/common';

/** Monotonic time source for in-process rate limits and cleanup throttles. */
@Injectable()
export class MonotonicClock {
  now(): number {
    return performance.now();
  }
}
