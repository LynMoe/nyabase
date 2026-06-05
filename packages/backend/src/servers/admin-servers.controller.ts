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
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ServersService } from './servers.service.js';
import { AgentGateway } from '../gateway/agent-gateway.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { RequireCaps } from '../auth/decorators/require-caps.decorator.js';
import {
  Capability,
  zAddDataDiskRequest,
  zCreateServerRequest,
  zDockerDaemonStatus,
  zUpdateDataDiskRequest,
  zUpdateServerDefaultsRequest,
  zUpdateServerRequest,
} from '@nyabase/common';

@Controller('admin/servers')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class AdminServersController {
  constructor(
    private serversService: ServersService,
    private agentGateway: AgentGateway,
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

  @Post(':id/disks')
  @RequireCaps(Capability.ManageServers)
  async addDisk(@Param('id') id: string, @Body() body: unknown) {
    const dto = zAddDataDiskRequest.parse(body);
    try {
      const disk = await this.serversService.addDisk(id, dto.mountPoint, dto.label);
      return {
        diskId: disk.id,
        mountPoint: disk.mountPoint,
        label: disk.label,
        operationId: disk.operationId,
        status: disk.operationStatus,
      };
    } catch (e) {
      if (e instanceof BadRequestException || e instanceof NotFoundException) throw e;
      throw new BadRequestException((e as Error).message);
    }
  }

  @Patch(':id/disks/:diskId')
  @RequireCaps(Capability.ManageServers)
  async updateDisk(
    @Param('id') id: string,
    @Param('diskId') diskId: string,
    @Body() body: unknown,
  ) {
    const dto = zUpdateDataDiskRequest.parse(body);
    try {
      const disk = await this.serversService.updateDisk(id.trim(), diskId.trim(), dto.label);
      const diskDto = await this.serversService.getDiskDto(id.trim(), disk.id);
      return {
        ...diskDto,
        operationId: disk.operationId,
        status: disk.operationStatus,
      };
    } catch (e) {
      if (e instanceof BadRequestException || e instanceof NotFoundException) throw e;
      throw new BadRequestException((e as Error).message);
    }
  }

  @Delete(':id/disks/:diskId')
  @RequireCaps(Capability.ManageServers)
  async removeDisk(@Param('id') id: string, @Param('diskId') diskId: string) {
    try {
      return await this.serversService.removeDisk(id.trim(), diskId.trim());
    } catch (e) {
      if (e instanceof BadRequestException || e instanceof NotFoundException) throw e;
      throw new BadRequestException((e as Error).message);
    }
  }

  @Patch(':id/defaults')
  @RequireCaps(Capability.ManageServers)
  async updateDefaults(@Param('id') id: string, @Body() body: unknown) {
    const dto = zUpdateServerDefaultsRequest.parse(body);
    return this.serversService.updateDefaults(id, dto);
  }

  @Get(':id')
  @RequireCaps(Capability.ManageServers)
  async get(@Param('id') id: string) {
    return this.serversService.findDtoById(id);
  }

  @Post(':id/docker-daemon/reconcile')
  @RequireCaps(Capability.ManageServers)
  async reconcileDockerDaemon(@Param('id') id: string) {
    await this.serversService.findById(id);
    if (!this.agentGateway.isOnline(id)) {
      throw new BadRequestException('Agent is offline, cannot reconcile docker daemon');
    }
    const rawStatus = await this.agentGateway.rpc(id, 'reconcileDockerDaemon', {}, 90_000);
    const status = zDockerDaemonStatus.parse(rawStatus);
    return this.serversService.persistDockerDaemonStatus(id, status);
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
