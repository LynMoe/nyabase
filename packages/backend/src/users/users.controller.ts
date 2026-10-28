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
import { SshClientConfigService } from './ssh-client-config.service.js';
import { RequireRole, CurrentActor } from '../iam/decorators.js';
import { RefuseImpersonation } from '../iam/decorators.js';
import { hasRole, type Actor, requireUserId } from '../iam/actor.js';
import {
  Role,
  zAddSshKeyRequest,
  zCreateUserRequest,
  zUpdateUserRequest,
} from '@nyabase/common';

/**
 * Users. Everyone manages their own record and SSH keys; user admins read,
 * create and change other users except admins (`assertCanAdministerUser` in
 * the service); roles and admins are changed by admins only. Anyone else is
 * refused with 403.
 */
@Controller('users')
export class UsersController {
  constructor(
    private usersService: UsersService,
    private sshKeys: UserSshKeysService,
    private sshClientConfig: SshClientConfigService,
  ) {}

  @Get()
  @RequireRole(Role.UserAdmin)
  async listUsers() {
    return this.usersService.listDtos();
  }

  @Post()
  @RequireRole(Role.UserAdmin)
  async createUser(@Body() body: unknown, @CurrentActor() actor: Actor) {
    const dto = zCreateUserRequest.parse(body);
    if (dto.role !== undefined && dto.role !== Role.User && !hasRole(actor, Role.Admin)) {
      throw new ForbiddenException();
    }
    const user = await this.usersService.createUser(dto, { actorId: actor.userId });
    return this.usersService.toDto(user, { withNote: true });
  }

  @Get(':id')
  async getUser(@Param('id') id: string, @CurrentActor() actor: Actor) {
    this.assertSelfOr(actor, id, Role.UserAdmin);
    const user = await this.usersService.findById(id);
    return this.usersService.toDto(user, { withNote: hasRole(actor, Role.UserAdmin) });
  }

  @Patch(':id')
  @RefuseImpersonation()
  async updateUser(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentActor() actor: Actor,
  ) {
    this.assertSelfOr(actor, id, Role.UserAdmin);
    const dto = zUpdateUserRequest.parse(body);
    if (dto.role !== undefined && !hasRole(actor, Role.Admin)) throw new ForbiddenException();
    const withNote = hasRole(actor, Role.UserAdmin);
    if (this.isSelfService(actor, id, dto)) {
      if (dto.status !== undefined || dto.role !== undefined || dto.note !== undefined) {
        throw new BadRequestException('status, role and note cannot be changed through the self-service route');
      }
      const user = await this.usersService.updateSelf(id, dto, dto.currentPassword);
      return this.usersService.toDto(user, { withNote });
    }
    if (dto.currentPassword !== undefined) {
      throw new BadRequestException('currentPassword is only valid for self-service updates');
    }
    const user = await this.usersService.updateUser(id, dto, requireUserId(actor));
    return this.usersService.toDto(user, { withNote });
  }

  @Delete(':id')
  @RequireRole(Role.UserAdmin)
  @HttpCode(200)
  async deleteUser(@Param('id') id: string, @CurrentActor() actor: Actor) {
    if (actor.userId === id) throw new ForbiddenException("Can't delete yourself");
    return this.usersService.deleteUserPermanently(actor, id);
  }

  // SSH keys

  @Get(':id/ssh-keys')
  async listSshKeys(@Param('id') id: string, @CurrentActor() actor: Actor) {
    if (actor.userId !== id) {
      this.assertSelfOr(actor, id, Role.UserAdmin);
      await this.usersService.findById(id);
    }
    return this.sshKeys.listSshKeys(id);
  }

  /** Yourself only: it carries your host CA, created on first use. */
  @Get(':id/ssh-client-config')
  async sshClientConfigFor(@Param('id') id: string, @CurrentActor() actor: Actor) {
    if (actor.userId !== id) throw new ForbiddenException();
    await this.usersService.findById(id);
    return this.sshClientConfig.forUser({ id });
  }

  @Post(':id/ssh-keys')
  @RefuseImpersonation()
  async addSshKey(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentActor() actor: Actor,
  ) {
    if (actor.userId !== id) throw new ForbiddenException();
    const dto = zAddSshKeyRequest.parse(body);
    return this.sshKeys.addSshKey(actor, dto.name, dto.keyText, dto.currentPassword);
  }

  @Delete(':id/ssh-keys/:keyId')
  @RefuseImpersonation()
  @HttpCode(204)
  async deleteSshKey(
    @Param('id') id: string,
    @Param('keyId') keyId: string,
    @CurrentActor() actor: Actor,
  ) {
    this.assertSelfOr(actor, id, Role.UserAdmin);
    await this.sshKeys.deleteSshKey(id, keyId, requireUserId(actor));
  }

  private assertSelfOr(actor: Actor, id: string, minimum: Role): void {
    if (actor.userId !== id && !hasRole(actor, minimum)) throw new ForbiddenException();
  }

  /**
   * Your own record follows the self-service rules (password changes need the
   * current password; status, role and the administrators' note are not yours
   * to change). An admin who sends an administrator-shaped change to their own
   * record (status, role, note, or a password without the current one) is
   * handled as an administrator. A user
   * admin is not: a stolen session must not reset its own password.
   */
  private isSelfService(
    actor: Actor,
    id: string,
    dto: { status?: unknown; role?: unknown; note?: unknown; password?: unknown; currentPassword?: unknown },
  ): boolean {
    if (actor.userId !== id) return false;
    const administratorShaped = dto.role !== undefined
      || dto.note !== undefined
      || (dto.currentPassword === undefined
        && (dto.status !== undefined || dto.password !== undefined));
    return !(administratorShaped && hasRole(actor, Role.Admin));
  }
}
