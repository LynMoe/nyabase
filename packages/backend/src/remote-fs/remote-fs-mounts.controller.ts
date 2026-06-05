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
import { Capability, zRemoteFsParams } from '@nyabase/common';
import { z } from 'zod';

const zCreateRemoteFs = z.object({
  name: z.string().min(1).max(128),
  displayName: z.string().max(128).optional(),
  description: z.string().optional(),
  serverIds: z.string().array().optional(),
  options: z.string().optional(),
  hostMountPoint: z.string().startsWith('/').optional(),
  params: zRemoteFsParams,
});

const zUpdateRemoteFs = z.object({
  name: z.string().min(1).max(128).optional(),
  displayName: z.string().max(128).optional(),
  description: z.string().optional(),
  options: z.string().optional(),
  hostMountPoint: z.string().startsWith('/').optional(),
  params: zRemoteFsParams.optional(),
});

const zAssignServer = z.object({
  serverId: z.string().min(1),
});

@Controller('admin/remote-fs-mounts')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class RemoteFsMountsController {
  constructor(private remoteFsMountsService: RemoteFsMountsService) {}

  @Get()
  @RequireCaps(Capability.ManageServers)
  async list(@Query('serverId') serverId?: string) {
    const mounts = await this.remoteFsMountsService.list(serverId);
    return Promise.all(
      mounts.map(async (m) => {
        const serverIds = await this.remoteFsMountsService.getServerIds(m.id);
        return {
          ...m,
          serverIds,
          serverStatuses: await this.remoteFsMountsService.getMountStatuses(m.id, serverIds),
        };
      }),
    );
  }

  @Post()
  @RequireCaps(Capability.ManageServers)
  async create(@Body() body: unknown, @CurrentUser() user: UserEntity) {
    const dto = zCreateRemoteFs.parse(body);
    const mount = await this.remoteFsMountsService.create(user.id, {
      name: dto.name,
      displayName: dto.displayName,
      description: dto.description,
      serverIds: dto.serverIds,
      type: dto.params.type,
      options: dto.options,
      hostMountPoint: dto.hostMountPoint,
      params: dto.params,
    });
    const serverIds = await this.remoteFsMountsService.getServerIds(mount.id);
    return {
      ...mount,
      serverIds,
      serverStatuses: await this.remoteFsMountsService.getMountStatuses(mount.id, serverIds),
    };
  }

  @Get(':id')
  @RequireCaps(Capability.ManageServers)
  async get(@Param('id') id: string) {
    const m = await this.remoteFsMountsService.findById(id);
    const serverIds = await this.remoteFsMountsService.getServerIds(id);
    return {
      ...m,
      serverIds,
      serverStatuses: await this.remoteFsMountsService.getMountStatuses(id, serverIds),
    };
  }

  @Patch(':id')
  @RequireCaps(Capability.ManageServers)
  async update(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: UserEntity) {
    const dto = zUpdateRemoteFs.parse(body);
    const mount = await this.remoteFsMountsService.update(user.id, id, {
      name: dto.name,
      displayName: dto.displayName,
      description: dto.description,
      options: dto.options,
      hostMountPoint: dto.hostMountPoint,
      params: dto.params,
    });
    const serverIds = await this.remoteFsMountsService.getServerIds(id);
    return {
      ...mount,
      serverIds,
      serverStatuses: await this.remoteFsMountsService.getMountStatuses(id, serverIds),
    };
  }

  @Delete(':id')
  @RequireCaps(Capability.ManageServers)
  async remove(@Param('id') id: string, @CurrentUser() user: UserEntity) {
    return this.remoteFsMountsService.remove(user.id, id);
  }

  @Post(':id/remount')
  @RequireCaps(Capability.ManageServers)
  async remount(@Param('id') id: string, @CurrentUser() user: UserEntity) {
    return this.remoteFsMountsService.remount(user.id, id);
  }

  // ---------------------------------------------------------------------------
  // Server assignments
  // ---------------------------------------------------------------------------

  @Get(':id/servers')
  @RequireCaps(Capability.ManageServers)
  async listServers(@Param('id') id: string) {
    return this.remoteFsMountsService.listServerAssignments(id);
  }

  @Post(':id/servers')
  @RequireCaps(Capability.ManageServers)
  async assignServer(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: UserEntity,
  ) {
    const { serverId } = zAssignServer.parse(body);
    return this.remoteFsMountsService.assignServer(user.id, id, serverId);
  }

  @Delete(':id/servers/:serverId')
  @RequireCaps(Capability.ManageServers)
  async unassignServer(
    @Param('id') id: string,
    @Param('serverId') serverId: string,
    @CurrentUser() user: UserEntity,
  ) {
    return this.remoteFsMountsService.unassignServer(user.id, id, serverId);
  }
}
