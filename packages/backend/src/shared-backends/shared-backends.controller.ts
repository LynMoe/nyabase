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
  zCreateSharedBackendRequest,
  zPatchSharedBackendRequest,
} from '@nyabase/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { RequireAnyCaps, RequireCaps } from '../auth/decorators/require-caps.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { UserRecord } from '../domain/domain-records.js';
import { SharedBackendsService } from './shared-backends.service.js';

@Controller('shared-backends')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class SharedBackendsController {
  constructor(private readonly service: SharedBackendsService) {}

  @Get()
  list(@CurrentUser() user: UserRecord) {
    return this.service.listForUser(user.id);
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user: UserRecord) {
    return this.service.getForUser(id, user.id);
  }
}

@Controller('admin/shared-backends')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
@RequireCaps(Capability.ManageSharedBackends)
export class AdminSharedBackendsController {
  constructor(private readonly service: SharedBackendsService) {}

  @Get()
  @RequireCaps()
  @RequireAnyCaps(Capability.ManageSharedBackends, Capability.ManageGrants)
  list() {
    return this.service.list();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Post()
  create(@Body() body: unknown) {
    return this.service.create(zCreateSharedBackendRequest.parse(body));
  }

  @Patch(':id')
  patch(@Param('id') id: string, @Body() body: unknown) {
    return this.service.patch(id, zPatchSharedBackendRequest.parse(body));
  }

  @Delete(':id')
  delete(@Param('id') id: string) {
    return this.service.delete(id);
  }
}
