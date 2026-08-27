import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  Capability,
  zCreateIpPoolRequest,
  zPatchIpPoolRequest,
} from '@nyabase/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { RequireCaps } from '../auth/decorators/require-caps.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { UserRecord } from '../domain/domain-records.js';
import { IpPoolsService } from './ip-pools.service.js';

@Controller('admin/ip-pools')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
@RequireCaps(Capability.ManageIpPools)
export class AdminIpPoolsController {
  constructor(private readonly service: IpPoolsService) {}

  @Get()
  list() {
    return this.service.list();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Post()
  create(@CurrentUser() user: UserRecord, @Body() body: unknown) {
    return this.service.create(user.id, zCreateIpPoolRequest.parse(body));
  }

  @Patch(':id')
  patch(
    @CurrentUser() user: UserRecord,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.service.patch(user.id, id, zPatchIpPoolRequest.parse(body));
  }

  @Delete(':id')
  delete(@CurrentUser() user: UserRecord, @Param('id') id: string) {
    return this.service.delete(user.id, id);
  }
}
