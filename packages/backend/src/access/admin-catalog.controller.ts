import { Controller, Get } from '@nestjs/common';
import { Role } from '@nyabase/common';
import { RequireRole } from '../iam/decorators.js';
import { CatalogPersistence } from './catalog.persistence.js';

/**
 * Purpose-safe selector data. These endpoints deliberately avoid reusing full
 * administrative DTOs, which would either require unrelated mutation
 * roles or disclose host fingerprints, secrets, and task authority.
 */
@Controller('admin/catalog')
export class AdminCatalogController {
  constructor(private readonly persistence: CatalogPersistence) {}

  @Get('users')
  @RequireRole(Role.Operator)
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
  @RequireRole(Role.Operator)
  async listGroups() {
    const rows = await this.persistence.listGroups();
    return rows.map((group) => ({
      id: group.id,
      name: group.name,
    }));
  }

  @Get('grant-servers')
  @RequireRole(Role.Operator)
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
  @RequireRole(Role.Operator)
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
