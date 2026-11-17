import { Injectable, NotFoundException } from '@nestjs/common';
import type { ContainerMaintenanceItemDto, ListScope } from '@nyabase/common';
import { assertCanAccess } from '../containers/container-rules.js';
import type { Actor } from '../iam/actor.js';
import { toMaintenanceItem } from './container-script-dtos.js';
import { ContainerScriptReadModel } from './container-script-read-model.js';

/**
 * The container owner's view of the scripts run in their container. The same
 * access rule as every container sub-resource: the owner by default, user
 * admins on anyone's container with `scope=all`.
 */
@Injectable()
export class ContainerMaintenanceService {
  constructor(private readonly read: ContainerScriptReadModel) {}

  async list(actor: Actor, containerId: string, scope: ListScope): Promise<ContainerMaintenanceItemDto[]> {
    const container = await this.read.containerOwner(containerId);
    if (!container) throw new NotFoundException('Container not found');
    assertCanAccess(actor, container, scope);
    return (await this.read.maintenance(containerId))
      // An archived script that never ran here has nothing to say any more.
      .filter((row) => row.status !== 'archived' || row.last_run !== null)
      .map(toMaintenanceItem)
      .filter((item): item is ContainerMaintenanceItemDto => item !== null);
  }
}
