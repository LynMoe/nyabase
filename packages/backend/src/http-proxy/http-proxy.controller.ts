import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { UserEntity } from '../entities/user.entity.js';
import { HttpProxyGateway } from './http-proxy-gateway.js';
import { HttpProxyService } from './http-proxy.service.js';
import { AuditAction } from '@nyabase/common';
import { AuditService } from '../audit/audit.service.js';
import { postCommitBestEffort } from '../common/post-commit.js';

@Controller('v2/http-proxy/bindings')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class HttpProxyController {
  constructor(
    private service: HttpProxyService,
    private gateway: HttpProxyGateway,
    private audit: AuditService,
  ) {}

  @Get()
  list(@CurrentUser() user: UserEntity) {
    return this.service.listBindings(user.id, this.gateway.isOnline());
  }

  @Post()
  async create(@CurrentUser() user: UserEntity, @Body() body: unknown) {
    const result = await this.service.createBinding(user.id, body);
    this.gateway.scheduleBroadcast('binding_created');
    await postCommitBestEffort(
      'HTTP proxy binding create audit',
      () => this.audit.log(user.id, AuditAction.CreateHttpProxyBinding, result.id, 'http_proxy_binding', {
        hostname: result.hostname,
        containerId: result.containerId,
        targetPort: result.targetPort,
      }),
    );
    return result;
  }

  @Patch(':id')
  async update(@CurrentUser() user: UserEntity, @Param('id') id: string, @Body() body: unknown) {
    const result = await this.service.updateBinding(user.id, id, body);
    this.gateway.scheduleBroadcast('binding_updated');
    await postCommitBestEffort(
      'HTTP proxy binding update audit',
      () => this.audit.log(user.id, AuditAction.UpdateHttpProxyBinding, result.id, 'http_proxy_binding', {
        hostname: result.hostname,
        containerId: result.containerId,
        targetPort: result.targetPort,
      }),
    );
    return result;
  }

  @Delete(':id')
  @HttpCode(204)
  async delete(@CurrentUser() user: UserEntity, @Param('id') id: string) {
    await this.service.deleteBinding(user.id, id);
    this.gateway.scheduleBroadcast('binding_deleted');
    await postCommitBestEffort(
      'HTTP proxy binding delete audit',
      () => this.audit.log(user.id, AuditAction.DeleteHttpProxyBinding, id, 'http_proxy_binding'),
    );
  }
}
