import { Controller, Get, UseGuards } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Capability, UserStatus } from '@nyabase/common';
import { Not, Repository } from 'typeorm';
import { RequireAnyCaps, RequireCaps } from '../auth/decorators/require-caps.decorator.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { GroupEntity } from '../entities/group.entity.js';
import { ImageEntity } from '../entities/image.entity.js';
import { RemoteFsMountEntity } from '../entities/remote-fs-mount.entity.js';
import { RemoteFsServerAssignmentEntity } from '../entities/remote-fs-server-assignment.entity.js';
import { ServerEntity } from '../entities/server.entity.js';
import { UserEntity } from '../entities/user.entity.js';
import { AgentGateway } from '../gateway/agent-gateway.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { AccessResolverService } from '../access/access-resolver.service.js';

/**
 * Purpose-safe selector data. These endpoints deliberately avoid reusing full
 * administrative DTOs, which would either require unrelated mutation
 * capabilities or disclose host fingerprints, secrets, and task authority.
 */
@Controller('admin/catalog')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class AdminCatalogController {
  constructor(
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    @InjectRepository(GroupEntity)
    private readonly groups: Repository<GroupEntity>,
    @InjectRepository(ImageEntity)
    private readonly images: Repository<ImageEntity>,
    @InjectRepository(RemoteFsMountEntity)
    private readonly remoteFsMounts: Repository<RemoteFsMountEntity>,
    @InjectRepository(RemoteFsServerAssignmentEntity)
    private readonly remoteFsAssignments: Repository<RemoteFsServerAssignmentEntity>,
    @InjectRepository(ServerEntity)
    private readonly servers: Repository<ServerEntity>,
    private readonly agentGateway: AgentGateway,
    private readonly accessResolver: AccessResolverService,
  ) {}

  @Get('administration-actions')
  @RequireAnyCaps(
    Capability.ManageUsers,
    Capability.ManageGroups,
  )
  administrationActions(@CurrentUser() actor: UserEntity) {
    return this.accessResolver.administrationActionsCurrent(actor.id);
  }

  @Get('users')
  @RequireAnyCaps(
    Capability.ManageUsers,
    Capability.ManageGroups,
    Capability.ManageGrants,
  )
  async listUsers() {
    const rows = await this.users.find({
      where: { status: Not(UserStatus.Deleted) },
      order: { username: 'ASC', id: 'ASC' },
    });
    return rows.map((user) => ({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      status: user.status,
    }));
  }

  @Get('groups')
  @RequireAnyCaps(Capability.ManageGroups, Capability.ManageGrants)
  async listGroups() {
    const rows = await this.groups.find({ order: { priority: 'DESC', name: 'ASC', id: 'ASC' } });
    return rows.map((group) => ({
      id: group.id,
      name: group.name,
      isSystem: group.isSystem,
    }));
  }

  @Get('grant-servers')
  @RequireCaps(Capability.ManageGrants)
  async listGrantServers() {
    const rows = await this.servers.find({ order: { name: 'ASC', id: 'ASC' } });
    return rows.map((server) => {
      const snapshot = this.agentGateway.stateCache.get(server.id);
      return {
        id: server.id,
        name: server.name,
        slug: server.slug,
        status: server.status,
        runtimeReady: snapshot?.runtimeReady === true,
        gpus: (snapshot?.gpus ?? []).map((gpu) => ({
          index: gpu.index,
          model: gpu.model,
          totalMemMiB: gpu.totalMemMiB,
        })),
      };
    });
  }

  @Get('grant-images')
  @RequireCaps(Capability.ManageGrants)
  async listGrantImages() {
    const rows = await this.images.find({
      where: { isActive: true, deleting: false },
      order: { name: 'ASC', id: 'ASC' },
    });
    return rows.map((image) => ({
      id: image.id,
      name: image.name,
      description: image.description,
      isActive: image.isActive,
    }));
  }

  @Get('grant-remote-fs-mounts')
  @RequireCaps(Capability.ManageGrants)
  async listGrantRemoteFsMounts() {
    const [mounts, assignments] = await Promise.all([
      this.remoteFsMounts.find({
        where: { desiredState: 'active' },
        order: { name: 'ASC', id: 'ASC' },
      }),
      this.remoteFsAssignments.find({
        where: { desiredState: 'active' },
        select: { remoteFsMountId: true, serverId: true },
      }),
    ]);
    const serverIdsByMount = new Map<string, string[]>();
    for (const assignment of assignments) {
      const serverIds = serverIdsByMount.get(assignment.remoteFsMountId) ?? [];
      serverIds.push(assignment.serverId);
      serverIdsByMount.set(assignment.remoteFsMountId, serverIds);
    }
    return mounts.map((mount) => ({
      id: mount.id,
      name: mount.name,
      displayName: mount.displayName,
      serverIds: (serverIdsByMount.get(mount.id) ?? []).sort(),
    }));
  }

  @Get('metric-servers')
  @RequireCaps(Capability.ViewMetricsAll)
  async listMetricServers() {
    const rows = await this.servers.find({ order: { name: 'ASC', id: 'ASC' } });
    return rows.map((server) => ({
      id: server.id,
      name: server.name,
      slug: server.slug,
      status: server.status,
      runtimeReady: this.agentGateway.stateCache.get(server.id)?.runtimeReady === true,
      hasGpu: (this.agentGateway.stateCache.get(server.id)?.gpus.length ?? 0) > 0,
    }));
  }
}
