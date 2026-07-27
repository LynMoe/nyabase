import { Injectable, OnApplicationBootstrap, Logger } from '@nestjs/common';
import { UsersService } from './users/users.service.js';
import { GroupsService } from './groups/groups.service.js';
import { RuntimeRoleService } from './runtime/runtime-role.service.js';

@Injectable()
export class AppService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AppService.name);

  constructor(
    private usersService: UsersService,
    private groupsService: GroupsService,
    private readonly runtimeRole: RuntimeRoleService,
  ) {}

  async onApplicationBootstrap() {
    if (!this.runtimeRole.servesApi()) return;
    await this.seedRequiredData();
  }

  /** Ensure the required system groups and default admin account exist. */
  private async seedRequiredData() {
    const { admins } = await this.groupsService.ensureSystemGroups();
    this.logger.log('System groups ready (Administrators, Operators, Users)');

    await this.usersService.ensureAdminExists(async (userId) => {
      await this.groupsService.addMember(admins.id, userId);
      this.logger.log('Default admin user created and added to Administrators');
    }, (excludedUserId) => this.groupsService.hasActiveSystemGroupMember(
      admins.id,
      excludedUserId,
    ));
  }
}
