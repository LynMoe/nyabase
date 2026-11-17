import { Module } from '@nestjs/common';
import { IncusModule } from '../incus/incus.module.js';
import { ReconcileModule } from '../reconcile/reconcile.module.js';
import { ContainerMaintenanceService } from './container-maintenance.service.js';
import { ContainerScriptReadModel } from './container-script-read-model.js';
import { ContainerScriptScheduler } from './container-script-scheduler.service.js';
import { ContainerScriptTargetsRepository } from './container-script-targets.repository.js';
import { AdminContainerScriptsController, ContainerMaintenanceController } from './container-scripts.controller.js';
import { ContainerScriptsRepository } from './container-scripts.repository.js';
import { ContainerScriptsService } from './container-scripts.service.js';

/**
 * Container scripts: administrator scripts run as root inside containers
 * (once per container or after every boot). Depends on platform / iam /
 * reconcile (wakes) / incus, and reads containers; nothing depends on it.
 */
@Module({
  imports: [IncusModule, ReconcileModule],
  providers: [
    ContainerScriptsRepository,
    ContainerScriptTargetsRepository,
    ContainerScriptReadModel,
    ContainerScriptsService,
    ContainerScriptScheduler,
    ContainerMaintenanceService,
  ],
  controllers: [AdminContainerScriptsController, ContainerMaintenanceController],
})
export class ContainerScriptsModule {}
