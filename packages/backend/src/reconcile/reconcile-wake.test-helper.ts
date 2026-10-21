import { ReconcileWakeService } from './reconcile-wake.service.js';

/** A wake service, for tests that construct repositories directly. */
export function noopWake(): ReconcileWakeService {
  return new ReconcileWakeService();
}
