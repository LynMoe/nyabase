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
} from '@nestjs/common';
import { UsersService } from './users.service.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { RequireCaps } from '../auth/decorators/require-caps.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { GroupsService } from '../groups/groups.service.js';
import { UserEntity } from '../entities/user.entity.js';
import { Capability, zCreateUserRequest, zUpdateUserRequest } from '@nyabase/common';

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
  async createUser(@Body() body: unknown) {
    const dto = zCreateUserRequest.parse(body);
    const user = await this.usersService.createUser(dto);
    await this.groupsService.ensureUserInGroup('Users', user.id);
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

  @Patch(':id')
  @RequireCaps(Capability.ManageUsers)
  async updateUser(@Param('id') id: string, @Body() body: unknown) {
    const dto = zUpdateUserRequest.parse(body);
    delete (dto as Record<string, unknown>).currentPassword;
    const user = await this.usersService.updateUser(id, dto);
    return this.usersService.toDto(user);
  }

  @Delete(':id')
  @RequireCaps(Capability.ManageUsers)
  @HttpCode(204)
  async deleteUser(@Param('id') id: string, @CurrentUser() currentUser: UserEntity) {
    if (currentUser.id === id) throw new ForbiddenException("Can't delete yourself");
    await this.groupsService.cleanupUserData(id);
    await this.usersService.deleteUser(id);
  }

  @Delete(':id/ssh-keys/:keyId')
  @RequireCaps(Capability.ManageUsers)
  @HttpCode(204)
  async deleteSshKey(
    @Param('id') id: string,
    @Param('keyId') keyId: string,
  ) {
    await this.usersService.deleteSshKey(id, keyId);
  }
}
