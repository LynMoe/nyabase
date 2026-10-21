import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  Capability,
  zCreateIpPoolRequest,
  zPatchIpPoolRequest,
} from '@nyabase/common';
import { RequireCaps } from '../iam/decorators/require-caps.decorator.js';
import { CurrentUser } from '../iam/decorators/current-user.decorator.js';
import type { UserRecord } from '../iam/user-record.js';
import { IpPoolsService } from './ip-pools.service.js';

@Controller('admin/ip-pools')
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
