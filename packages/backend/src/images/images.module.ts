import { Module } from '@nestjs/common';
import { InfrastructureModule } from '../infrastructure/infrastructure.module.js';
import { ReconcileModule } from '../reconcile/reconcile.module.js';
import { SshModule } from '../ssh/ssh.module.js';
import { AdminImagesController } from './admin-images.controller.js';
import { ImageAssignmentReconciler } from './image-assignment-reconciler.service.js';
import { ImageCatalogService } from './image-catalog.js';
import {
  AdminImageAssignmentIntentsController,
  AdminImageIntentsController,
} from './image-intents.controller.js';
import { ImagesController } from './images.controller.js';
import { ImagesService } from './images.service.js';

@Module({
  imports: [ReconcileModule, SshModule, InfrastructureModule],
  providers: [ImageCatalogService, ImagesService, ImageAssignmentReconciler],
  controllers: [
    ImagesController,
    AdminImagesController,
    AdminImageAssignmentIntentsController,
    AdminImageIntentsController,
  ],
  exports: [ImagesService],
})
export class ImagesModule {}
