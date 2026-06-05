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
  UnauthorizedException,
} from '@nestjs/common';
import { UsersService } from './users.service.js';
import { AuthService } from '../auth/auth.service.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { UserEntity } from '../entities/user.entity.js';
import { zUpdateUserRequest, zAddSshKeyRequest } from '@nyabase/common';

@Controller('users')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class UsersController {
  constructor(
    private usersService: UsersService,
    private authService: AuthService,
  ) {}

  @Get(':id')
  async getUser(@Param('id') id: string, @CurrentUser() currentUser: UserEntity) {
    if (currentUser.id !== id) throw new ForbiddenException();
    const user = await this.usersService.findById(id);
    return this.usersService.toDto(user);
  }

  @Patch(':id')
  async updateUser(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() currentUser: UserEntity,
  ) {
    if (currentUser.id !== id) throw new ForbiddenException();
    const dto = zUpdateUserRequest.parse(body);
    delete (dto as Record<string, unknown>).status;
    if (dto.password) {
      if (!dto.currentPassword) {
        throw new BadRequestException('Current password is required');
      }
      const targetUser = await this.usersService.findById(id);
      const valid = await this.authService.verifyPassword(targetUser.passwordHash, dto.currentPassword);
      if (!valid) throw new UnauthorizedException('Current password is incorrect');
    }
    const { currentPassword: _, ...updateDto } = dto;
    const user = await this.usersService.updateUser(id, updateDto);
    return this.usersService.toDto(user);
  }

  // SSH Keys

  @Get(':id/ssh-keys')
  async listSshKeys(@Param('id') id: string, @CurrentUser() currentUser: UserEntity) {
    if (currentUser.id !== id) throw new ForbiddenException();
    return this.usersService.listSshKeys(id);
  }

  @Post(':id/ssh-keys')
  async addSshKey(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() currentUser: UserEntity,
  ) {
    if (currentUser.id !== id) throw new ForbiddenException();
    const dto = zAddSshKeyRequest.parse(body);
    return this.usersService.addSshKey(id, dto.name, dto.keyText);
  }

  @Delete(':id/ssh-keys/:keyId')
  @HttpCode(204)
  async deleteSshKey(
    @Param('id') id: string,
    @Param('keyId') keyId: string,
    @CurrentUser() currentUser: UserEntity,
  ) {
    if (currentUser.id !== id) throw new ForbiddenException();
    await this.usersService.deleteSshKey(id, keyId);
  }
}
