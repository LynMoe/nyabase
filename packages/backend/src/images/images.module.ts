import { Module } from '@nestjs/common';
import { ReconcileModule } from '../reconcile/reconcile.module.js';
import { SshModule } from '../ssh/ssh.module.js';
import { ImageAssignmentReconciler } from './image-assignment-reconciler.service.js';
import { ImageCatalogService } from './image-catalog.js';
import { ImageReconcileStore } from './image-reconcile.store.js';
import { ImagesController } from './images.controller.js';
import { ImagesService } from './images.service.js';
import { ImageVersionsService } from './image-versions.service.js';

@Module({
  imports: [ReconcileModule, SshModule],
  providers: [ImageCatalogService, ImagesService, ImageVersionsService, ImageReconcileStore, ImageAssignmentReconciler],
  controllers: [
    ImagesController,
  ],
  exports: [ImagesService],
})
export class ImagesModule {}
