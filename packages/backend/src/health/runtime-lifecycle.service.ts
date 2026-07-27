import {
  BeforeApplicationShutdown,
  Injectable,
} from '@nestjs/common';

/**
 * Readiness admission barrier. The process becomes ready only after every
 * role-specific HTTP/WebSocket gateway has attached, and becomes unready
 * before Nest starts closing dependency connections.
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
