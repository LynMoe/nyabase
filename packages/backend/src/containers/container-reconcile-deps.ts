import type { Logger } from '@nestjs/common';
import type { AuditService } from '../iam/audit.service.js';
import type { ContainerReconcileStore } from './container-reconcile.store.js';
import type { IncusContainerSshStateAdapter } from './container-ssh-state.adapter.js';

/** What the container reconcile steps need; the reconciler builds one per instance. */
export interface ContainerReconcileDeps {
  readonly store: ContainerReconcileStore;
  readonly audit: AuditService;
  readonly logger: Logger;
  readonly sshState: IncusContainerSshStateAdapter;
}
