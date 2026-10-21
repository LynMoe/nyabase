import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  HttpCode,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { UsersService } from './users.service.js';
import { UserSshKeysService } from './user-ssh-keys.service.js';
import { RequireAnyCaps, RequireCaps, CurrentActor } from '../iam/decorators.js';
import { holdsAny, type Actor } from '../iam/actor.js';
import {
  Capability,
  SystemGroupKey,
  zAddSshKeyRequest,
  zCreateUserRequest,
  zUpdateUserRequest,
} from '@nyabase/common';

const VIEW_USERS = [Capability.ManageUsers, Capability.ManageGrants] as const;

/**
 * Users. Everyone manages their own record and SSH keys; reading other users
 * needs `ManageUsers`/`ManageGrants`, changing them needs `ManageUsers`.
 * Anyone else is refused with 403.
 */
@Controller('users')
export class UsersController {
  constructor(
    private usersService: UsersService,
    private sshKeys: UserSshKeysService,
  ) {}

  @Get()
  @RequireAnyCaps(...VIEW_USERS)
  async listUsers() {
    return this.usersService.listDtos();
  }

  @Post()
  @RequireCaps(Capability.ManageUsers)
  async createUser(@Body() body: unknown, @CurrentActor() actor: Actor) {
    const dto = zCreateUserRequest.parse(body);
    const user = await this.usersService.createUser(dto, {
      systemGroupKey: SystemGroupKey.Users,
      actorId: actor.userId,
    });
    return this.usersService.toDto(user);
  }

  @Get(':id')
  async getUser(@Param('id') id: string, @CurrentActor() actor: Actor) {
    this.assertSelfOr(actor, id, VIEW_USERS);
    const user = await this.usersService.findById(id);
    return this.usersService.toDto(user);
  }

  @Patch(':id')
  async updateUser(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentActor() actor: Actor,
  ) {
    this.assertSelfOr(actor, id, [Capability.ManageUsers]);
    const dto = zUpdateUserRequest.parse(body);
    if (this.isSelfService(actor, id, dto)) {
      if (dto.status !== undefined) {
        throw new BadRequestException('status cannot be changed through the self-service route');
      }
      const user = await this.usersService.updateSelf(id, dto, dto.currentPassword);
      return this.usersService.toDto(user);
    }
    if (dto.currentPassword !== undefined) {
      throw new BadRequestException('currentPassword is only valid for self-service updates');
    }
    const user = await this.usersService.updateUser(id, dto, actor.userId);
    return this.usersService.toDto(user);
  }

  @Delete(':id')
  @RequireCaps(Capability.ManageUsers)
  @HttpCode(200)
  async deleteUser(@Param('id') id: string, @CurrentActor() actor: Actor) {
    if (actor.userId === id) throw new ForbiddenException("Can't delete yourself");
    return this.usersService.deleteUserPermanently(actor, id);
  }

  // SSH keys

  @Get(':id/ssh-keys')
  async listSshKeys(@Param('id') id: string, @CurrentActor() actor: Actor) {
    if (actor.userId !== id) {
      this.assertSelfOr(actor, id, [Capability.ManageUsers]);
      await this.usersService.findById(id);
    }
    return this.sshKeys.listSshKeys(id);
  }

  @Post(':id/ssh-keys')
  async addSshKey(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentActor() actor: Actor,
  ) {
    if (actor.userId !== id) throw new ForbiddenException();
    const dto = zAddSshKeyRequest.parse(body);
    return this.sshKeys.addSshKey(id, dto.name, dto.keyText, actor.userId);
  }

  @Delete(':id/ssh-keys/:keyId')
  @HttpCode(204)
  async deleteSshKey(
    @Param('id') id: string,
    @Param('keyId') keyId: string,
    @CurrentActor() actor: Actor,
  ) {
    this.assertSelfOr(actor, id, [Capability.ManageUsers]);
    await this.sshKeys.deleteSshKey(id, keyId, actor.userId);
  }

  private assertSelfOr(actor: Actor, id: string, anyOf: readonly Capability[]): void {
    if (actor.userId !== id && !holdsAny(actor, anyOf)) throw new ForbiddenException();
  }

  /**
   * Your own record follows the self-service rules (password changes need the
   * current password; status is not yours to change). A `ManageUsers` holder
   * who sends an administrator-shaped change to their own record (status, or a
   * password without the current one) is handled as an administrator.
   */
  private isSelfService(
    actor: Actor,
    id: string,
    dto: { status?: unknown; password?: unknown; currentPassword?: unknown },
  ): boolean {
    if (actor.userId !== id) return false;
    const administratorShaped = dto.currentPassword === undefined
      && (dto.status !== undefined || dto.password !== undefined);
    return !(administratorShaped && actor.capabilities.has(Capability.ManageUsers));
  }
}
