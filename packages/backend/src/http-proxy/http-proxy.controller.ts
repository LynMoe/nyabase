import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { UserRecord } from '../domain/domain-records.js';
import { HttpProxyGateway } from './http-proxy-gateway.js';
import { HttpProxyService } from './http-proxy.service.js';

@Controller('http-proxy/bindings')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class HttpProxyController {
  constructor(
    private service: HttpProxyService,
    private gateway: HttpProxyGateway,
  ) {}

  @Get()
  list(@CurrentUser() user: UserRecord) {
    return this.service.listBindings(user.id, this.gateway.isOnline());
  }

  @Post()
  async create(@CurrentUser() user: UserRecord, @Body() body: unknown) {
    const result = await this.service.createBinding(user.id, body);
    this.gateway.scheduleBroadcast('binding_created');
    return result;
  }

  @Patch(':id')
  async update(@CurrentUser() user: UserRecord, @Param('id') id: string, @Body() body: unknown) {
    const result = await this.service.updateBinding(user.id, id, body);
    this.gateway.scheduleBroadcast('binding_updated');
    return result;
  }

  @Delete(':id')
  @HttpCode(204)
  async delete(@CurrentUser() user: UserRecord, @Param('id') id: string) {
    await this.service.deleteBinding(user.id, id);
    this.gateway.scheduleBroadcast('binding_deleted');
  }
}

@Controller('http-proxy/domain-pools')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class HttpProxyDomainPoolsController {
  constructor(private service: HttpProxyService) {}

  @Get()
  listEnabled() {
    return this.service.listEnabledDomainPools();
  }
}
