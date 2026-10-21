import { Module } from '@nestjs/common';
import { InfrastructureModule } from '../infrastructure/infrastructure.module.js';
import { ReconcileModule } from '../reconcile/reconcile.module.js';
import { SshModule } from '../ssh/ssh.module.js';
import { ImageAssignmentReconciler } from './image-assignment-reconciler.service.js';
import { ImageCatalogService } from './image-catalog.js';
import { ImagesController } from './images.controller.js';
import { ImagesService } from './images.service.js';

@Module({
  imports: [ReconcileModule, SshModule, InfrastructureModule],
  providers: [ImageCatalogService, ImagesService, ImageAssignmentReconciler],
  controllers: [
    ImagesController,
  ],
  exports: [ImagesService],
})
export class ImagesModule {}
