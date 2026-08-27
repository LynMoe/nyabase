import {
  Controller,
  Get,
  Param,
  NotFoundException,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { UserRecord } from '../domain/domain-records.js';
import { AccessResolverService } from '../access/access-resolver.service.js';
import { ServersService } from './servers.service.js';

@Controller('servers')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class ServersController {
  constructor(
    private readonly servers: ServersService,
    private readonly access: AccessResolverService,
  ) {}

  @Get()
  async list(@CurrentUser() user: UserRecord) {
    return this.servers.findUserDtosByIds(
      await this.access.listAccessibleServers(user.id),
    );
  }

  @Get(':id')
  async get(@Param('id') id: string, @CurrentUser() user: UserRecord) {
    await this.requireAccess(user.id, id);
    return this.servers.findUserDtoById(id);
  }

  @Get(':id/gpus')
  async gpus(@Param('id') id: string, @CurrentUser() user: UserRecord) {
    return { items: await this.servers.listGpusForUser(user.id, id) };
  }

  private async requireAccess(userId: string, serverId: string): Promise<void> {
    if (!(await this.access.listAccessibleServers(userId)).includes(serverId)) {
      throw new NotFoundException('Server not found');
    }
  }
}
