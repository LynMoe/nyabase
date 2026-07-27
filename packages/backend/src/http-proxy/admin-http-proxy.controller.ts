import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Capability } from '@nyabase/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { UserRecord } from '../domain/domain-records.js';
import { RequireCaps } from '../auth/decorators/require-caps.decorator.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { HttpProxyGateway } from './http-proxy-gateway.js';
import { HttpProxyService } from './http-proxy.service.js';

@Controller('admin/http-proxy')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class AdminHttpProxyController {
  constructor(
    private service: HttpProxyService,
    private gateway: HttpProxyGateway,
  ) {}

  @Get('status')
  @RequireCaps(Capability.ViewMetricsAll)
  status() {
    return this.gateway.getStatus();
  }

  @Get('domain-pools')
  @RequireCaps(Capability.ManageSystemSettings)
  listDomainPools() {
    return this.service.listDomainPools();
  }

  @Post('domain-pools')
  @RequireCaps(Capability.ManageSystemSettings)
  async createDomainPool(@CurrentUser() actor: UserRecord, @Body() body: unknown) {
    const result = await this.service.createDomainPool(actor.id, body);
    this.gateway.scheduleBroadcast('domain_pool_created');
    return result;
  }

  @Patch('domain-pools/:id')
  @RequireCaps(Capability.ManageSystemSettings)
  async updateDomainPool(
    @CurrentUser() actor: UserRecord,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const result = await this.service.updateDomainPool(actor.id, id, body);
    this.gateway.scheduleBroadcast('domain_pool_updated');
    return result;
  }

  @Delete('domain-pools/:id')
  @HttpCode(204)
  @RequireCaps(Capability.ManageSystemSettings)
  async deleteDomainPool(@CurrentUser() actor: UserRecord, @Param('id') id: string) {
    await this.service.deleteDomainPool(actor.id, id);
    this.gateway.scheduleBroadcast('domain_pool_deleted');
  }
}
