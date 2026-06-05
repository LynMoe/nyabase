import {
  Controller,
  Get,
  Param,
  UseGuards,
  NotFoundException,
} from '@nestjs/common';
import { ServersService } from './servers.service.js';
import { AgentGateway } from '../gateway/agent-gateway.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { AccessResolverService } from '../access/access-resolver.service.js';
import { UserEntity } from '../entities/user.entity.js';

@Controller('servers')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class ServersController {
  constructor(
    private serversService: ServersService,
    private accessResolver: AccessResolverService,
    private agentGateway: AgentGateway,
  ) {}

  @Get()
  async list(@CurrentUser() user: UserEntity) {
    const accessibleIds = await this.accessResolver.listAccessibleServers(user.id);
    return this.serversService.findDtosByIds(accessibleIds);
  }

  @Get(':id/quota')
  async getUserQuota(@Param('id') id: string, @CurrentUser() user: UserEntity) {
    await this.ensureServerAccess(user.id, id);
    return this.serversService.getUserQuota(id, user.id);
  }

  @Get(':id/gpus')
  async getGpus(@Param('id') id: string, @CurrentUser() user: UserEntity) {
    await this.ensureServerAccess(user.id, id);
    return this.agentGateway.stateCache.get(id)?.gpus ?? [];
  }

  @Get(':id/disks')
  async listDisks(@Param('id') id: string, @CurrentUser() user: UserEntity) {
    await this.ensureServerAccess(user.id, id);
    return this.serversService.listDiskDtos(id);
  }

  @Get(':id')
  async get(@Param('id') id: string, @CurrentUser() user: UserEntity) {
    const accessibleIds = await this.accessResolver.listAccessibleServers(user.id);
    if (!accessibleIds.includes(id)) {
      throw new NotFoundException('Server not found');
    }
    return this.serversService.findDtoById(id);
  }

  private async ensureServerAccess(userId: string, serverId: string) {
    const accessibleIds = await this.accessResolver.listAccessibleServers(userId);
    if (!accessibleIds.includes(serverId)) {
      throw new NotFoundException('Server not found');
    }
  }
}
