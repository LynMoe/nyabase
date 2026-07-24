import { Controller, Param, Post, UseGuards } from '@nestjs/common';
import { Capability } from '@nyabase/common';
import { AuditAction } from '@nyabase/common';
import { RequireCaps } from '../auth/decorators/require-caps.decorator.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { AgentGateway } from '../gateway/agent-gateway.js';
import { AgentTaskDispatcherService } from './agent-task-dispatcher.service.js';
import { AgentTaskFinalizerWorkerService } from './agent-task-finalizer-worker.service.js';
import { AgentTasksService } from './agent-tasks.service.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { UserEntity } from '../entities/user.entity.js';
import { AccessResolverService } from '../access/access-resolver.service.js';
import { AuditService } from '../audit/audit.service.js';
import { postCommitBestEffort } from '../common/post-commit.js';

@Controller('admin/servers')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
@RequireCaps(Capability.ManageServers)
export class AdminAgentQuarantineController {
  constructor(
    private readonly tasks: AgentTasksService,
    private readonly dispatcher: AgentTaskDispatcherService,
    private readonly finalizerWorker: AgentTaskFinalizerWorkerService,
    private readonly gateway: AgentGateway,
    private readonly accessResolver: AccessResolverService,
    private readonly audit: AuditService,
  ) {}

  @Post(':serverId/agent-quarantine/retry')
  async retry(@Param('serverId') serverId: string, @CurrentUser() actor: UserEntity) {
    const taskIds = await this.tasks.retryAgentQuarantine(
      serverId,
      async (manager) => {
        await this.accessResolver.assertActorCapabilitiesInTransaction(
          manager, actor.id, [Capability.ManageServers],
        );
      },
      (work) => this.gateway.runWithSessionFence(
        serverId,
        'Invalid Agent result quarantine retry started',
        work,
        {
          authorizeAndClaim: (claim) => this.accessResolver.runWithActorCapabilities(
            actor.id,
            [Capability.ManageServers],
            async () => { claim(); },
          ),
        },
      ),
    );
    await postCommitBestEffort(
      'Agent quarantine retry audit',
      () => this.audit.log(
        actor.id,
        AuditAction.RetryAgentQuarantine,
        serverId,
        'server',
        { taskIds },
      ),
    );
    this.dispatcher.wake();
    this.finalizerWorker.wake();
    return { taskIds };
  }
}
