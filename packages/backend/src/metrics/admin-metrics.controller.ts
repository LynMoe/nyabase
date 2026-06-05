import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Capability, ContainerMetricsDto, GpuMetricsDto, HostMetricsDto, UserMetricsDto } from '@nyabase/common';
import { Repository } from 'typeorm';
import { AccessResolverService } from '../access/access-resolver.service.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { RequireCaps } from '../auth/decorators/require-caps.decorator.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { UserEntity } from '../entities/user.entity.js';
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
    @InjectRepository(ContainerEntity)
    containersRepo: Repository<ContainerEntity>,
    agentGateway: AgentGateway,
  ) {
    super(metricsQuery, accessResolver, usersService, containersRepo, agentGateway);
  }

  @Get('servers/:id/host')
  async adminHostMetrics(
    @Param('id') serverId: string,
    @Query('range') range: string,
  ): Promise<HostMetricsDto> {
    return this.hostMetricsFor(serverId, range);
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
    @CurrentUser() user: UserEntity,
    @Query('range') range: string,
  ): Promise<UserMetricsDto> {
    return this.userMetricsFor(serverId, user, range, true);
  }

  @Get('servers/:id/containers')
  async adminContainerMetrics(
    @Param('id') serverId: string,
    @CurrentUser() user: UserEntity,
    @Query('range') range: string,
  ): Promise<ContainerMetricsDto> {
    return this.containerMetricsFor(serverId, user, range, true);
  }

  @Get('query')
  async adminRawQuery(
    @Query('query') query: string,
    @Query('time') time?: string,
  ) {
    return this.rawQueryFor(query, time);
  }

  @Get('query_range')
  async adminRawQueryRange(
    @Query('query') query: string,
    @Query('start') start?: string,
    @Query('end') end?: string,
    @Query('step') step?: string,
  ) {
    return this.rawQueryRangeFor(query, start, end, step);
  }
}
