import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { RemoteFsMountsService } from './remote-fs-mounts.service.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { RequireCaps } from '../auth/decorators/require-caps.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { UserEntity } from '../entities/user.entity.js';
import {
  Capability,
  zCreateRemoteFsMountRequest,
  zResourceIdentity,
  zUpdateRemoteFsMountRequest,
} from '@nyabase/common';
import { z } from 'zod';

const zAssignServer = z.object({
  serverId: zResourceIdentity,
}).strict();

@Controller('admin/remote-fs-mounts')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class RemoteFsMountsController {
  constructor(private remoteFsMountsService: RemoteFsMountsService) {}

  @Get()
  @RequireCaps(Capability.ManageServers)
  async list(@Query('serverId') serverId?: string) {
    const parsedServerId = serverId === undefined ? undefined : zResourceIdentity.parse(serverId);
    const mounts = await this.remoteFsMountsService.list(parsedServerId);
    return Promise.all(
      mounts.map(async (m) => {
        const serverIds = await this.remoteFsMountsService.getServerIds(m.id);
        const serverStatuses = await this.remoteFsMountsService.getMountStatuses(m.id, serverIds);
        return this.remoteFsMountsService.toDto(m, serverIds, serverStatuses);
      }),
    );
  }

  @Post()
  @RequireCaps(Capability.ManageServers)
  async create(@Body() body: unknown, @CurrentUser() user: UserEntity) {
    const dto = zCreateRemoteFsMountRequest.parse(body);
    const mount = await this.remoteFsMountsService.create(user.id, {
      name: dto.name,
      displayName: dto.displayName,
      description: dto.description,
      serverIds: dto.serverIds,
      type: dto.params.type,
      options: dto.options,
      params: dto.params,
    });
    const serverIds = await this.remoteFsMountsService.getServerIds(mount.id);
    const serverStatuses = await this.remoteFsMountsService.getMountStatuses(mount.id, serverIds);
    return this.remoteFsMountsService.toDto(mount, serverIds, serverStatuses);
  }

  @Get(':id')
  @RequireCaps(Capability.ManageServers)
  async get(@Param('id') id: string) {
    const mountId = zResourceIdentity.parse(id);
    const m = await this.remoteFsMountsService.findById(mountId);
    const serverIds = await this.remoteFsMountsService.getServerIds(mountId);
    const serverStatuses = await this.remoteFsMountsService.getMountStatuses(mountId, serverIds);
    return this.remoteFsMountsService.toDto(m, serverIds, serverStatuses);
  }

  @Patch(':id')
  @RequireCaps(Capability.ManageServers)
  async update(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: UserEntity) {
    const mountId = zResourceIdentity.parse(id);
    const dto = zUpdateRemoteFsMountRequest.parse(body);
    const mount = await this.remoteFsMountsService.update(user.id, mountId, {
      name: dto.name,
      displayName: dto.displayName,
      description: dto.description,
    });
    const serverIds = await this.remoteFsMountsService.getServerIds(mountId);
    const serverStatuses = await this.remoteFsMountsService.getMountStatuses(mountId, serverIds);
    return this.remoteFsMountsService.toDto(mount, serverIds, serverStatuses);
  }

  @Delete(':id')
  @RequireCaps(Capability.ManageServers)
  async remove(@Param('id') id: string, @CurrentUser() user: UserEntity) {
    return this.remoteFsMountsService.remove(user.id, zResourceIdentity.parse(id));
  }

  // ---------------------------------------------------------------------------
  // Server assignments
  // ---------------------------------------------------------------------------

  @Get(':id/servers')
  @RequireCaps(Capability.ManageServers)
  async listServers(@Param('id') id: string) {
    return this.remoteFsMountsService.listServerAssignments(zResourceIdentity.parse(id));
  }

  @Post(':id/servers')
  @RequireCaps(Capability.ManageServers)
  async assignServer(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: UserEntity,
  ) {
    const mountId = zResourceIdentity.parse(id);
    const { serverId } = zAssignServer.parse(body);
    return this.remoteFsMountsService.assignServer(user.id, mountId, serverId);
  }

  @Delete(':id/servers/:serverId')
  @RequireCaps(Capability.ManageServers)
  async unassignServer(
    @Param('id') id: string,
    @Param('serverId') serverId: string,
    @CurrentUser() user: UserEntity,
  ) {
    return this.remoteFsMountsService.unassignServer(
      user.id,
      zResourceIdentity.parse(id),
      zResourceIdentity.parse(serverId),
    );
  }
}
