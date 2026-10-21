import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { Capability } from '@nyabase/common';
import { CurrentUser } from '../iam/decorators/current-user.decorator.js';
import type { UserRecord } from '../iam/user-record.js';
import { RequireAnyCaps, RequireCaps } from '../iam/decorators/require-caps.decorator.js';
import { HttpProxyGateway } from './http-proxy-gateway.js';
import { HttpProxyService } from './http-proxy.service.js';

@Controller('admin/http-proxy')
export class AdminHttpProxyController {
  constructor(
    private service: HttpProxyService,
    private gateway: HttpProxyGateway,
  ) {}

  @Get('status')
  @RequireAnyCaps(
    Capability.ViewMetricsAll,
    Capability.ViewAudit,
    Capability.ManageSystemSettings,
  )
  status() {
    return this.gateway.getStatus();
  }

  @Get('bindings')
  @RequireCaps(Capability.ManageSystemSettings)
  listBindings(@CurrentUser() actor: UserRecord) {
    return this.service.listBindingsForAdmin(actor.id, this.gateway.isOnline());
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
