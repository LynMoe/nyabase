import type { AuditService } from '../iam/audit.service.js';
import type { ImageReconcileStore } from './image-reconcile.store.js';

/** What the image reconcile steps need; the reconciler builds one per instance. */
export interface ImageReconcileDeps {
  readonly store: ImageReconcileStore;
  readonly audit: AuditService;
}
