import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  HttpCode,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { UsersService } from './users.service.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { RequireCaps } from '../auth/decorators/require-caps.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { GroupsService } from '../groups/groups.service.js';
import { UserEntity } from '../entities/user.entity.js';
import { Capability, SystemGroupKey, zCreateUserRequest, zUpdateUserRequest } from '@nyabase/common';

@Controller('admin/users')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class AdminUsersController {
  constructor(
    private usersService: UsersService,
    private groupsService: GroupsService,
  ) {}

  @Get()
  @RequireCaps(Capability.ManageUsers)
  async listUsers() {
    const users = await this.usersService.findAll();
    return Promise.all(users.map((u) => this.usersService.toDto(u)));
  }

  @Post()
  @RequireCaps(Capability.ManageUsers)
  async createUser(@Body() body: unknown, @CurrentUser() actor: UserEntity) {
    const dto = zCreateUserRequest.parse(body);
    const user = await this.usersService.createUser(dto, {
      systemGroupKey: SystemGroupKey.Users,
      actorId: actor.id,
    });
    return this.usersService.toDto(user);
  }

  @Get(':id')
  @RequireCaps(Capability.ManageUsers)
  async getUser(@Param('id') id: string) {
    const user = await this.usersService.findById(id);
    return this.usersService.toDto(user);
  }

  @Get(':id/ssh-keys')
  @RequireCaps(Capability.ManageUsers)
  async listSshKeys(@Param('id') id: string) {
    await this.usersService.findById(id);
    return this.usersService.listSshKeys(id);
  }

  @Get(':id/internal-ssh-key')
  @RequireCaps(Capability.ManageUsers)
  async getInternalSshKey(
    @Param('id') id: string,
    @Query('includePrivate') includePrivate: string | undefined,
    @CurrentUser() currentUser: UserEntity,
  ) {
    return this.usersService.getInternalSshKey(currentUser.id, id, includePrivate === 'true');
  }

  @Post(':id/internal-ssh-key/rotate')
  @RequireCaps(Capability.ManageUsers)
  async rotateInternalSshKey(
    @Param('id') id: string,
    @CurrentUser() currentUser: UserEntity,
  ) {
    return this.usersService.rotateInternalSshKey(currentUser.id, id);
  }

  @Patch(':id')
  @RequireCaps(Capability.ManageUsers)
  async updateUser(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() actor: UserEntity,
  ) {
    const dto = zUpdateUserRequest.parse(body);
    if (dto.currentPassword !== undefined) {
      throw new BadRequestException('currentPassword is only valid for self-service updates');
    }
    const user = await this.usersService.updateUser(id, dto, actor.id);
    return this.usersService.toDto(user);
  }

  @Delete(':id')
  @RequireCaps(Capability.ManageUsers)
  @HttpCode(200)
  async deleteUser(@Param('id') id: string, @CurrentUser() currentUser: UserEntity) {
    if (currentUser.id === id) throw new ForbiddenException("Can't delete yourself");
    return this.groupsService.deleteUserPermanently(id, currentUser.id);
  }

  @Delete(':id/ssh-keys/:keyId')
  @RequireCaps(Capability.ManageUsers)
  @HttpCode(204)
  async deleteSshKey(
    @Param('id') id: string,
    @Param('keyId') keyId: string,
    @CurrentUser() actor: UserEntity,
  ) {
    await this.usersService.deleteSshKey(id, keyId, actor.id);
  }
}
