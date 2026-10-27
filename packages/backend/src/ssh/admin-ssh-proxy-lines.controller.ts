import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import {
  Role,
  zCreateSshProxyLineRequest,
  zPatchSshProxyLineRequest,
  zReorderSshProxyLinesRequest,
} from '@nyabase/common';
import type { UserRecord } from '../iam/auth-persistence.js';
import { CurrentUser, RequireRole } from '../iam/decorators.js';
import { SshProxyLinesService } from './ssh-proxy-lines.service.js';

/** The SSH proxy's public addresses; users read them through `GET /users/:id/ssh-client-config`. */
@Controller('admin/ssh-proxy/lines')
@RequireRole(Role.Admin)
export class AdminSshProxyLinesController {
  constructor(private readonly lines: SshProxyLinesService) {}

  @Get()
  list() {
    return this.lines.list();
  }

  @Post()
  create(@CurrentUser() user: UserRecord, @Body() body: unknown) {
    return this.lines.create(user.id, zCreateSshProxyLineRequest.parse(body));
  }

  /** Declared before `:id` so it is not taken for a line id. */
  @Put('order')
  reorder(@CurrentUser() user: UserRecord, @Body() body: unknown) {
    return this.lines.reorder(user.id, zReorderSshProxyLinesRequest.parse(body));
  }

  @Patch(':id')
  patch(@CurrentUser() user: UserRecord, @Param('id') id: string, @Body() body: unknown) {
    return this.lines.patch(user.id, id, zPatchSshProxyLineRequest.parse(body));
  }

  @Delete(':id')
  delete(@CurrentUser() user: UserRecord, @Param('id') id: string) {
    return this.lines.delete(user.id, id);
  }
}
