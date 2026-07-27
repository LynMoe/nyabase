import { Controller, Get, Inject, Param, Query, UseGuards } from '@nestjs/common';
import { Capability, ContainerMetricsDto, GpuMetricsDto, HostMetricsDto, UserMetricsDto } from '@nyabase/common';
import type { Kysely } from 'kysely';
import { AccessResolverService } from '../access/access-resolver.service.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { RequireCaps } from '../auth/decorators/require-caps.decorator.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import type { UserRecord } from '../domain/domain-records.js';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import { UsersService } from '../users/users.service.js';
import { MetricsController } from './metrics.controller.js';
import { MetricsQueryService } from './metrics-query.service.js';
import { AgentGateway } from '../gateway/agent-gateway.js';

@Controller('admin/metrics')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
@RequireCaps(Capability.ViewMetricsAll)
export class AdminMetricsController extends MetricsController {
  constructor(
    metricsQuery: MetricsQueryService,
    accessResolver: AccessResolverService,
    usersService: UsersService,
    @Inject(PG_DATABASE)
    database: Kysely<NyabaseDatabase>,
    agentGateway: AgentGateway,
  ) {
    super(metricsQuery, accessResolver, usersService, database, agentGateway);
  }

  @Get('servers/:id/host')
  async adminHostMetrics(
    @Param('id') serverId: string,
    @Query('range') range: string,
  ): Promise<HostMetricsDto> {
    return this.hostMetricsFor(serverId, range, { includePhysicalTopology: true });
  }

  @Get('servers/:id/gpus')
  async adminGpuMetrics(
    @Param('id') serverId: string,
    @Query('range') range: string,
  ): Promise<GpuMetricsDto> {
    return this.gpuMetricsFor(serverId, range);
  }

  @Get('servers/:id/users')
  async adminUserMetrics(
    @Param('id') serverId: string,
    @CurrentUser() user: UserRecord,
    @Query('range') range: string,
  ): Promise<UserMetricsDto> {
    return this.userMetricsFor(serverId, user, range, true);
  }

  @Get('servers/:id/containers')
  async adminContainerMetrics(
    @Param('id') serverId: string,
    @CurrentUser() user: UserRecord,
    @Query('range') range: string,
  ): Promise<ContainerMetricsDto> {
    return this.containerMetricsFor(serverId, user, range, true);
  }
}
