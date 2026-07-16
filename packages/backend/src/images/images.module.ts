import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ImagesService } from './images.service.js';
import { ImagesController } from './images.controller.js';
import { AdminImagesController } from './admin-images.controller.js';
import { ImageEntity } from '../entities/image.entity.js';
import { ServerEntity } from '../entities/server.entity.js';
import { AuthModule } from '../auth/auth.module.js';
import { AccessModule } from '../access/access.module.js';
import { AgentGatewayModule } from '../gateway/agent-gateway.module.js';
import { AgentTasksModule } from '../agent-tasks/agent-tasks.module.js';
import { SshModule } from '../ssh/ssh.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([ImageEntity, ServerEntity]),
    AuthModule,
    AccessModule,
    AgentGatewayModule,
    AgentTasksModule,
    SshModule,
  ],
  providers: [ImagesService],
  controllers: [ImagesController, AdminImagesController],
  exports: [ImagesService],
})
export class ImagesModule {}
