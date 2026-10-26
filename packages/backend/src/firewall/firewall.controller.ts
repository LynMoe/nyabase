import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { Role, zCreateFirewallRuleRequest, zPatchFirewallRuleRequest } from '@nyabase/common';
import type { UserRecord } from '../iam/auth-persistence.js';
import { CurrentUser, RequireRole } from '../iam/decorators.js';
import { FirewallService } from './firewall.service.js';

@Controller('admin/firewall-rules')
@RequireRole(Role.Admin)
export class AdminFirewallRulesController {
  constructor(private readonly service: FirewallService) {}

  @Get()
  list() {
    return this.service.list();
  }

  /** Declared before `:id` so it is not taken for a rule id. */
  @Get('status')
  status() {
    return this.service.status();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Post()
  create(@CurrentUser() user: UserRecord, @Body() body: unknown) {
    return this.service.create(user.id, zCreateFirewallRuleRequest.parse(body));
  }

  @Patch(':id')
  patch(@CurrentUser() user: UserRecord, @Param('id') id: string, @Body() body: unknown) {
    return this.service.patch(user.id, id, zPatchFirewallRuleRequest.parse(body));
  }

  @Delete(':id')
  delete(@CurrentUser() user: UserRecord, @Param('id') id: string) {
    return this.service.delete(user.id, id);
  }
}
