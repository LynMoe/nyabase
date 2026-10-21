import { Module } from '@nestjs/common';
import { IncusModule } from '../incus/incus.module.js';
import { IntentsController } from './intents.controller.js';
import { IntentRepository } from './intent.repository.js';
import { ReconcileClaimRepository } from './reconcile-claim.repository.js';
import { ReconcileWakeService } from './reconcile-wake.service.js';
import { ReconcileWorkerService } from './reconcile-worker.service.js';
import { ReconcilerRegistry } from './reconciler-registry.service.js';

/**
 * Generic intent/reconcile engine. Domain modules register their
 * `ManagedReconciler` with the registry; nothing here imports a domain.
 */
@Module({
  imports: [IncusModule],
  providers: [
    ReconcileWakeService,
    IntentRepository,
    ReconcileClaimRepository,
    ReconcilerRegistry,
    ReconcileWorkerService,
  ],
  controllers: [IntentsController],
  exports: [
    IntentRepository,
    ReconcileClaimRepository,
    ReconcileWakeService,
    ReconcilerRegistry,
  ],
})
export class ReconcileModule {}
