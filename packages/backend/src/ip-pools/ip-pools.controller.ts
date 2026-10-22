import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { zCreateIpPoolRequest, zPatchIpPoolRequest, Role } from '@nyabase/common';
import { RequireRole, CurrentUser } from '../iam/decorators.js';
import type { UserRecord } from '../iam/auth-persistence.js';
import { IpPoolsService } from './ip-pools.service.js';

@Controller('admin/ip-pools')
@RequireRole(Role.Admin)
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
