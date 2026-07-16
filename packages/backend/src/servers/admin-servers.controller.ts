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

@Controller('admin/servers')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class AdminServersController {
  constructor(
    private serversService: ServersService,
  ) {}

  @Get()
  @RequireCaps(Capability.ManageServers)
  async list() {
    return this.serversService.findAllDtos();
  }

  @Get('all-disks')
  @RequireCaps(Capability.ManageGrants)
  async listAllDisks() {
    return this.serversService.listAllDisks();
  }

  @Post()
  @RequireCaps(Capability.ManageServers)
  async create(@Body() body: unknown) {
    const dto = zCreateServerRequest.parse(body);
    const { server, agentToken } = await this.serversService.create(dto);
    return { server, agentToken };
  }

  @Post(':id/regenerate-token')
  @RequireCaps(Capability.ManageServers)
  async regenerateToken(@Param('id') id: string) {
    const token = await this.serversService.regenerateToken(id);
    return { token };
  }

  @Get(':id/self-check')
  @RequireCaps(Capability.ManageServers)
  async selfCheck(@Param('id') id: string) {
    return this.serversService.selfCheck(id);
  }

  @Get(':id/disks')
  @RequireCaps(Capability.ManageServers)
  async listDisks(@Param('id') id: string) {
    return this.serversService.listDiskDtos(id);
  }

  @Get(':id')
  @RequireCaps(Capability.ManageServers)
  async get(@Param('id') id: string) {
    return this.serversService.findDtoById(id);
  }

  @Patch(':id')
  @RequireCaps(Capability.ManageServers)
  async update(@Param('id') id: string, @Body() body: unknown) {
    const dto = zUpdateServerRequest.parse(body);
    return this.serversService.update(id, dto);
  }

  @Delete(':id')
  @RequireCaps(Capability.ManageServers)
  @HttpCode(204)
  async delete(@Param('id') id: string) {
    await this.serversService.delete(id);
  }
}
