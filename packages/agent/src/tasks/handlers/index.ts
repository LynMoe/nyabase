import type { AgentConfig } from '../../config.js';
import type { DataDirsManager } from '../../datadirs/data-dirs.js';
import type { DockerClient } from '../../docker/docker-client.js';
import type { PhysicalReferenceGuard } from '../../docker/physical-reference-guard.js';
import type { DropbearManager } from '../../dropbear/dropbear-manager.js';
import type { RemoteFsMounter } from '../../fs/remote-fs-mounter.js';
import type { XfsQuotaManager } from '../../quota/xfs-quota.js';
import type { AgentWsClient } from '../../ws/client.js';
import { AgentTaskHandlerRegistry } from '../task-handler.js';
import { ContainerTaskHandler } from './container-task.handler.js';
import { DataDirTaskHandler } from './data-dir-task.handler.js';
import { ImageTaskHandler } from './image-task.handler.js';
import { QuotaTaskHandler } from './quota-task.handler.js';
import { RemoteFsTaskHandler } from './remote-fs-task.handler.js';

export interface AgentTaskHandlerDependencies {
  config: AgentConfig;
  docker: DockerClient;
  physicalReferenceGuard: PhysicalReferenceGuard;
  quota: XfsQuotaManager;
  dataDirs: DataDirsManager;
  remoteFsMounter: RemoteFsMounter;
  dropbear: DropbearManager;
  ws: AgentWsClient;
}

export function createAgentTaskHandlerRegistry(
  dependencies: AgentTaskHandlerDependencies,
): AgentTaskHandlerRegistry {
  return new AgentTaskHandlerRegistry([
    new ContainerTaskHandler(
      dependencies.config,
      dependencies.docker,
      dependencies.quota,
      dependencies.dropbear,
      dependencies.dataDirs,
      dependencies.remoteFsMounter,
    ),
    new DataDirTaskHandler(
      dependencies.dataDirs,
      dependencies.quota,
      dependencies.remoteFsMounter,
      dependencies.ws,
      dependencies.physicalReferenceGuard,
    ),
    new RemoteFsTaskHandler(dependencies.remoteFsMounter, dependencies.dataDirs),
    new QuotaTaskHandler(dependencies.quota),
    new ImageTaskHandler(dependencies.docker),
  ]);
}
