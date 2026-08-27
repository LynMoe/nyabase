import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AccessModule } from '../access/access.module.js';
import { DatabaseModule } from '../database/database.module.js';
import {
  AdminSharedBackendsController,
  SharedBackendsController,
} from './shared-backends.controller.js';
import { SharedBackendsRepository } from './shared-backends.repository.js';
import { SharedBackendsService } from './shared-backends.service.js';

@Module({
  imports: [AuthModule, AccessModule, DatabaseModule],
  providers: [SharedBackendsRepository, SharedBackendsService],
  controllers: [SharedBackendsController, AdminSharedBackendsController],
  exports: [SharedBackendsRepository, SharedBackendsService],
})
export class SharedBackendsModule {}
