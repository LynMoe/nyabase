import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  HttpCode,
} from '@nestjs/common';
import { ServersService } from './servers.service.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { RequireCaps } from '../auth/decorators/require-caps.decorator.js';
import {
  Capability,
  zCreateServerRequest,
  zUpdateServerRequest,
} from '@nyabase/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { UserEntity } from '../entities/user.entity.js';

@Controller('admin/servers')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class AdminServersController {
  constructor(
    private serversService: ServersService,
  ) {}

  @Get()
  @RequireCaps(Capability.ManageServers)
  async list() {
    return this.serversService.findAllDtos({ includeHostFingerprint: true });
  }

  @Get('all-disks')
  @RequireCaps(Capability.ManageGrants)
  async listAllDisks() {
    return this.serversService.listAllDisks();
  }

  @Post()
  @RequireCaps(Capability.ManageServers)
  async create(@CurrentUser() actor: UserEntity, @Body() body: unknown) {
    const dto = zCreateServerRequest.parse(body);
    const { server, agentToken } = await this.serversService.create(actor.id, dto);
    return { server, agentToken };
  }

  @Post(':id/regenerate-token')
  @RequireCaps(Capability.ManageServers)
  async regenerateToken(@Param('id') id: string, @CurrentUser() actor: UserEntity) {
    const token = await this.serversService.regenerateToken(actor.id, id);
    return { token };
  }

  @Get(':id/self-check')
  @RequireCaps(Capability.ManageServers)
  async selfCheck(@Param('id') id: string, @CurrentUser() actor: UserEntity) {
    return this.serversService.selfCheck(actor.id, id);
  }

  @Get(':id/disks')
  @RequireCaps(Capability.ManageServers)
  async listDisks(@Param('id') id: string) {
    return this.serversService.listDiskDtos(id);
  }

  @Get(':id')
  @RequireCaps(Capability.ManageServers)
  async get(@Param('id') id: string) {
    return this.serversService.findDtoById(id, { includeHostFingerprint: true });
  }

  @Patch(':id')
  @RequireCaps(Capability.ManageServers)
  async update(
    @Param('id') id: string,
    @CurrentUser() actor: UserEntity,
    @Body() body: unknown,
  ) {
    const dto = zUpdateServerRequest.parse(body);
    return this.serversService.update(actor.id, id, dto);
  }

  @Delete(':id')
  @RequireCaps(Capability.ManageServers)
  @HttpCode(204)
  async delete(@Param('id') id: string, @CurrentUser() actor: UserEntity) {
    await this.serversService.delete(actor.id, id);
  }
}
