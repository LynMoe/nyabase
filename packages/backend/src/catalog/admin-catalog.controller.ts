import { Controller, Get, UseGuards } from '@nestjs/common';
import { Capability } from '@nyabase/common';
import { RequireAnyCaps, RequireCaps } from '../auth/decorators/require-caps.decorator.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import type { UserRecord } from '../domain/domain-records.js';
import { AgentGateway } from '../gateway/agent-gateway.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { AccessResolverService } from '../access/access-resolver.service.js';
import { CatalogPersistence } from './catalog.persistence.js';

/**
 * Purpose-safe selector data. These endpoints deliberately avoid reusing full
 * administrative DTOs, which would either require unrelated mutation
 * capabilities or disclose host fingerprints, secrets, and task authority.
 */
@Controller('admin/catalog')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class AdminCatalogController {
  constructor(
    private readonly persistence: CatalogPersistence,
    private readonly agentGateway: AgentGateway,
    private readonly accessResolver: AccessResolverService,
  ) {}

  @Get('administration-actions')
  @RequireAnyCaps(
    Capability.ManageUsers,
    Capability.ManageGroups,
  )
  administrationActions(@CurrentUser() actor: UserRecord) {
    return this.accessResolver.administrationActionsCurrent(actor.id);
  }

  @Get('users')
  @RequireAnyCaps(
    Capability.ManageUsers,
    Capability.ManageGroups,
    Capability.ManageGrants,
  )
  async listUsers() {
    const rows = await this.persistence.listUsers();
    return rows.map((user) => ({
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      status: user.status,
    }));
  }

  @Get('groups')
  @RequireAnyCaps(Capability.ManageGroups, Capability.ManageGrants)
  async listGroups() {
    const rows = await this.persistence.listGroups();
    return rows.map((group) => ({
      id: group.id,
      name: group.name,
      isSystem: group.is_system,
    }));
  }

  @Get('grant-servers')
  @RequireCaps(Capability.ManageGrants)
  async listGrantServers() {
    const rows = await this.persistence.listServers();
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
    const rows = await this.persistence.listActiveImages();
    return rows.map((image) => ({
      id: image.id,
      name: image.name,
      description: image.description,
      isActive: image.is_active,
    }));
  }

  @Get('grant-remote-fs-mounts')
  @RequireCaps(Capability.ManageGrants)
  async listGrantRemoteFsMounts() {
    return this.persistence.listActiveRemoteFsMounts();
  }

  @Get('metric-servers')
  @RequireCaps(Capability.ViewMetricsAll)
  async listMetricServers() {
    const rows = await this.persistence.listServers();
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
