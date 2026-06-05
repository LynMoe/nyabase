import { Injectable } from '@nestjs/common';
import { ContainerControlService } from './container-control.service.js';

/**
 * Transitional shell kept only as the Nest module export name while the V2
 * control plane is wired through ContainerControlService. It intentionally does
 * not expose old direct action methods or old serverId+containerId helpers.
 */
@Injectable()
export class ContainersService {
  constructor(private control: ContainerControlService) {}

  get v2(): ContainerControlService {
    return this.control;
  }
}
