import type { Logger } from '@nestjs/common';
import type { AuditService } from '../iam/audit.service.js';
import type { IncusClientFactory } from '../incus/incus-client.factory.js';
import type { VolumeReconcileStore } from './volume-reconcile.store.js';

/** What the volume reconcile steps need; the reconciler builds one per instance. */
export interface VolumeReconcileDeps {
  readonly store: VolumeReconcileStore;
  readonly audit: AuditService;
  readonly clients: IncusClientFactory;
  readonly logger: Logger;
}
