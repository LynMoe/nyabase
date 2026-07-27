import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  HttpCode,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { UsersService } from './users.service.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { UserRecord } from '../domain/domain-records.js';
import { zUpdateUserRequest, zAddSshKeyRequest } from '@nyabase/common';

@Controller('users')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class UsersController {
  constructor(
    private usersService: UsersService,
  ) {}

  @Get(':id')
  async getUser(@Param('id') id: string, @CurrentUser() currentUser: UserRecord) {
    if (currentUser.id !== id) throw new ForbiddenException();
    const user = await this.usersService.findById(id);
    return this.usersService.toDto(user);
  }

  @Patch(':id')
  async updateUser(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() currentUser: UserRecord,
  ) {
    if (currentUser.id !== id) throw new ForbiddenException();
    const dto = zUpdateUserRequest.parse(body);
    if (dto.status !== undefined) {
      throw new BadRequestException('status cannot be changed through the self-service route');
    }
    const user = await this.usersService.updateSelf(
      id,
      dto,
      dto.currentPassword,
    );
    return this.usersService.toDto(user);
  }

  // SSH Keys

  @Get(':id/ssh-keys')
  async listSshKeys(@Param('id') id: string, @CurrentUser() currentUser: UserRecord) {
    if (currentUser.id !== id) throw new ForbiddenException();
    return this.usersService.listSshKeys(id);
  }

  @Post(':id/ssh-keys')
  async addSshKey(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() currentUser: UserRecord,
  ) {
    if (currentUser.id !== id) throw new ForbiddenException();
    const dto = zAddSshKeyRequest.parse(body);
    return this.usersService.addSshKey(id, dto.name, dto.keyText, currentUser.id);
  }

  @Delete(':id/ssh-keys/:keyId')
  @HttpCode(204)
  async deleteSshKey(
    @Param('id') id: string,
    @Param('keyId') keyId: string,
    @CurrentUser() currentUser: UserRecord,
  ) {
    if (currentUser.id !== id) throw new ForbiddenException();
    await this.usersService.deleteSshKey(id, keyId, currentUser.id);
  }
}
