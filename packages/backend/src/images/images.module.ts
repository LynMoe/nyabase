import { Module } from '@nestjs/common';
import { ImageCatalogService } from './image-catalog.js';
import { ImagesService } from './images.service.js';
import { ImagesController } from './images.controller.js';
import { AdminImagesController } from './admin-images.controller.js';
import { SshModule } from '../ssh/ssh.module.js';
import { InfrastructureModule } from '../infrastructure/infrastructure.module.js';
import { RuntimeModule } from '../runtime/runtime.module.js';

@Module({
  imports: [
    SshModule,
    InfrastructureModule,
    RuntimeModule,
  ],
  providers: [ImageCatalogService, ImagesService],
  controllers: [ImagesController, AdminImagesController],
  exports: [ImagesService],
})
export class ImagesModule {}
