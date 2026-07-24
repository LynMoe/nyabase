import {
  Controller,
  Get,
  Param,
  UseGuards,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { GpuGrantMode, type UserDataDiskDto } from '@nyabase/common';
import type { EntityManager } from 'typeorm';
import { ServersService } from './servers.service.js';
import { AgentGateway } from '../gateway/agent-gateway.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import {
  AccessResolverService,
  type ResolvedServerGrant,
} from '../access/access-resolver.service.js';
import { UserEntity } from '../entities/user.entity.js';
import { publicDataDiskDisplayName } from '../mount-sources/utils.js';

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
    return this.serversService.findUserDtosByIds(accessibleIds);
  }

  @Get(':id/quota')
  async getUserQuota(@Param('id') id: string, @CurrentUser() user: UserEntity) {
    await this.ensureServerAccess(user.id, id);
    return this.serversService.getUserQuota(id, user.id);
  }

  @Get(':id/gpus')
  async getGpus(@Param('id') id: string, @CurrentUser() user: UserEntity) {
    const grant = await this.withCurrentServerAccess(
      user.id,
      id,
      async (_manager, currentGrant) => currentGrant,
    );
    return (this.agentGateway.stateCache.get(id)?.gpus ?? [])
      .filter((gpu) => gpuAllowedByGrant(grant, gpu.index))
      .map((gpu) => ({
        index: gpu.index,
        model: gpu.model,
        totalMemMiB: gpu.totalMemMiB,
      }));
  }

  @Get(':id/disks')
  async listDisks(
    @Param('id') id: string,
    @CurrentUser() user: UserEntity,
  ): Promise<UserDataDiskDto[]> {
    // Keep one immutable inventory view for both exact-identity authorization
    // and projection. If the Agent replaces a disk concurrently, the old
    // grant cannot accidentally authorize the replacement at the same id.
    const disks = [...(this.agentGateway.stateCache.get(id)?.disks ?? [])];
    return this.withCurrentServerAccess(user.id, id, async (manager) => {
      const result: UserDataDiskDto[] = [];
      for (const disk of disks) {
        const allowed = await this.accessResolver.hasMountSourceAccessInTransaction(
          manager,
          user.id,
          id,
          { kind: 'local', id: disk.diskId },
          disk.sourceIdentity,
        );
        if (!allowed) continue;
        result.push({
          diskId: disk.diskId,
          displayName: publicDataDiskDisplayName(disk.diskId, disk.label),
          totalBytes: disk.totalBytes,
          usedBytes: disk.usedBytes,
          pquotaEnabled: disk.pquotaEnabled,
        });
      }
      return result;
    });
  }

  @Get(':id')
  async get(@Param('id') id: string, @CurrentUser() user: UserEntity) {
    const accessibleIds = await this.accessResolver.listAccessibleServers(user.id);
    if (!accessibleIds.includes(id)) {
      throw new NotFoundException('Server not found');
    }
    return this.serversService.findUserDtoById(id);
  }

  private async ensureServerAccess(userId: string, serverId: string) {
    const accessibleIds = await this.accessResolver.listAccessibleServers(userId);
    if (!accessibleIds.includes(serverId)) {
      throw new NotFoundException('Server not found');
    }
  }

  private async withCurrentServerAccess<T>(
    userId: string,
    serverId: string,
    work: (manager: EntityManager, grant: ResolvedServerGrant) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.accessResolver.runWithActiveServerAccess(
        userId,
        serverId,
        async (manager) => {
          const grant = await this.accessResolver.resolveServerInTransaction(
            manager,
            userId,
            serverId,
          );
          if (!grant) throw new ForbiddenException('Server access was revoked');
          return work(manager, grant);
        },
      );
    } catch (error) {
      if (!(error instanceof ForbiddenException)) throw error;
      throw new NotFoundException('Server not found');
    }
  }
}

function gpuAllowedByGrant(grant: ResolvedServerGrant, index: number): boolean {
  if (grant.gpuMode === GpuGrantMode.All) return true;
  if (grant.gpuMode === GpuGrantMode.None) return false;
  return grant.gpuIndices.includes(index);
}
