import { Controller, Get } from '@nestjs/common';
import { Capability } from '@nyabase/common';
import { RequireAnyCaps, RequireCaps, CurrentUser } from '../iam/decorators.js';
import type { UserRecord } from '../iam/auth-persistence.js';
import { AccessResolverService } from '../iam/access-resolver.service.js';
import { CatalogPersistence } from './catalog.persistence.js';

/**
 * Purpose-safe selector data. These endpoints deliberately avoid reusing full
 * administrative DTOs, which would either require unrelated mutation
 * capabilities or disclose host fingerprints, secrets, and task authority.
 */
@Controller('admin/catalog')
export class AdminCatalogController {
  constructor(
    private readonly persistence: CatalogPersistence,
    private readonly accessResolver: AccessResolverService,
  ) {}

  @Get('administration-actions')
  @RequireAnyCaps(
    Capability.ManageUsers,
    Capability.ManageGroups,
  )
  administrationActions(@CurrentUser() actor: UserRecord) {
    return this.accessResolver.administrationActions(actor.id);
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
    return rows.map((server) => ({
      id: server.id,
      name: server.name,
      slug: server.slug,
      status: server.status,
      runtimeReady: server.status === 'online' && server.preflight_status === 'passed',
      gpus: [],
    }));
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
      runtimeReady: server.status === 'online' && server.preflight_status === 'passed',
      gpuEnabled: server.gpu_enabled,
    }));
  }
}
