import {
  BeforeApplicationShutdown,
  Injectable,
} from '@nestjs/common';

/**
 * Readiness admission barrier. The process becomes ready after Nest has
 * initialized the runtime worker and HTTP surface, and becomes unready before
 * dependency connections begin closing.
 */
@Injectable()
export class RuntimeLifecycleService implements BeforeApplicationShutdown {
  private acceptingTraffic = false;

  markReady(): void {
    this.acceptingTraffic = true;
  }

  beforeApplicationShutdown(): void {
    this.acceptingTraffic = false;
  }

  isAcceptingTraffic(): boolean {
    return this.acceptingTraffic;
  }
}
