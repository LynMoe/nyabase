import {
  Controller,
  Get,
  Query,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { MountSourcesService } from './mount-sources.service.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { UserEntity } from '../entities/user.entity.js';

@Controller('mount-sources')
@UseGuards(JwtAuthGuard)
export class MountSourcesController {
  constructor(private mountSourcesService: MountSourcesService) {}

  /**
   * GET /mount-sources?serverId=...
   * Returns sources the current user may access on the given server.
   */
  @Get()
  async list(@CurrentUser() user: UserEntity, @Query('serverId') serverId: string) {
    if (!serverId) throw new BadRequestException('serverId is required');
    return this.mountSourcesService.listForUser(user.id, serverId);
  }
}
