import {
  Controller,
  Get,
  Param,
  NotFoundException,
} from '@nestjs/common';
import { CurrentUser } from '../iam/decorators/current-user.decorator.js';
import type { UserRecord } from '../iam/user-record.js';
import { AccessResolverService } from '../iam/access-resolver.service.js';
import { ServersService } from './servers.service.js';

@Controller('servers')
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

  private async requireAccess(userId: string, serverId: string): Promise<void> {
    if (!(await this.access.listAccessibleServers(userId)).includes(serverId)) {
      throw new NotFoundException('Server not found');
    }
  }
}
