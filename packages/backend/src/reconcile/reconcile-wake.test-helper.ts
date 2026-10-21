import { ReconcileWakeService } from './reconcile-wake.service.js';

/** A wake service with no PostgreSQL listener, for tests that construct repositories directly. */
export function noopWake(): ReconcileWakeService {
  return new ReconcileWakeService(undefined as never);
}
