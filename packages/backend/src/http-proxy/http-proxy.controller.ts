import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { UserEntity } from '../entities/user.entity.js';
import { HttpProxyGateway } from './http-proxy-gateway.js';
import { HttpProxyService } from './http-proxy.service.js';

@Controller('v2/http-proxy/bindings')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class HttpProxyController {
  constructor(
    private service: HttpProxyService,
    private gateway: HttpProxyGateway,
  ) {}

  @Get()
  list(@CurrentUser() user: UserEntity) {
    return this.service.listBindings(user.id, this.gateway.isOnline());
  }

  @Post()
  async create(@CurrentUser() user: UserEntity, @Body() body: unknown) {
    const result = await this.service.createBinding(user.id, body);
    this.gateway.scheduleBroadcast('binding_created');
    return result;
  }

  @Patch(':id')
  async update(@CurrentUser() user: UserEntity, @Param('id') id: string, @Body() body: unknown) {
    const result = await this.service.updateBinding(user.id, id, body);
    this.gateway.scheduleBroadcast('binding_updated');
    return result;
  }

  @Delete(':id')
  @HttpCode(204)
  async delete(@CurrentUser() user: UserEntity, @Param('id') id: string) {
    await this.service.deleteBinding(user.id, id);
    this.gateway.scheduleBroadcast('binding_deleted');
  }
}
