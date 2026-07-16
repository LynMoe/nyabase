import { Controller, Param, Post, UseGuards } from '@nestjs/common';
import { Capability } from '@nyabase/common';
import { RequireCaps } from '../auth/decorators/require-caps.decorator.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { AgentGateway } from '../gateway/agent-gateway.js';
import { AgentTaskDispatcherService } from './agent-task-dispatcher.service.js';
import { AgentTaskFinalizerWorkerService } from './agent-task-finalizer-worker.service.js';
import { AgentTasksService } from './agent-tasks.service.js';

@Controller('admin/servers')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
@RequireCaps(Capability.ManageServers)
export class AdminAgentQuarantineController {
  constructor(
    private readonly tasks: AgentTasksService,
    private readonly dispatcher: AgentTaskDispatcherService,
    private readonly finalizerWorker: AgentTaskFinalizerWorkerService,
    private readonly gateway: AgentGateway,
  ) {}

  @Post(':serverId/agent-quarantine/retry')
  async retry(@Param('serverId') serverId: string) {
    const taskIds = await this.gateway.runWithSessionFence(
      serverId,
      'Invalid Agent result quarantine retry started',
      () => this.tasks.retryAgentQuarantine(serverId),
    );
    this.dispatcher.wake();
    this.finalizerWorker.wake();
    return { taskIds };
  }
}
