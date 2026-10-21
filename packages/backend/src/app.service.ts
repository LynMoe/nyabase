import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { SystemGroupKey } from '@nyabase/common';
import { GroupsService } from './groups/groups.service.js';
import { UsersService } from './users/users.service.js';

@Injectable()
export class AppService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AppService.name);

  constructor(
    private readonly groups: GroupsService,
    private readonly users: UsersService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.groups.ensureSystemGroups();
    await this.users.ensureAdminExists((userId) =>
      this.groups.ensureUserInSystemGroup(SystemGroupKey.Administrators, userId));
    this.logger.log('Initialized system IAM');
  }
}
