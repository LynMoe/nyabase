import { Controller, Param, Post, UseGuards } from '@nestjs/common';
import { Capability } from '@nyabase/common';
import { AuditAction } from '@nyabase/common';
import { RequireCaps } from '../auth/decorators/require-caps.decorator.js';
import { CapabilitiesGuard } from '../auth/guards/capabilities.guard.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { AgentTaskDispatcherService } from './agent-task-dispatcher.service.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { UserRecord } from '../domain/domain-records.js';
import { AccessResolverService } from '../access/access-resolver.service.js';
import { AuditService } from '../audit/audit.service.js';
import { WorkflowRepository } from './workflow.repository.js';
import { WorkflowFinalizerWorkerService } from './workflow-finalizer-worker.service.js';

@Controller('admin/servers')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
@RequireCaps(Capability.ManageServers)
export class AdminAgentQuarantineController {
  constructor(
    private readonly dispatcher: AgentTaskDispatcherService,
    private readonly accessResolver: AccessResolverService,
    private readonly audit: AuditService,
    private readonly workflow: WorkflowRepository,
    private readonly workflowFinalizers: WorkflowFinalizerWorkerService,
  ) {}

  @Post(':serverId/agent-quarantine/retry')
  async retry(@Param('serverId') serverId: string, @CurrentUser() actor: UserRecord) {
    const taskIds = await this.workflow.retryAgentQuarantine(
      serverId,
      async (transaction, retryTaskIds) => {
        await this.accessResolver.assertActorCapabilitiesInTransaction(
          transaction,
          actor.id,
          [Capability.ManageServers],
        );
        await this.audit.append(
          transaction,
          actor.id,
          AuditAction.RetryAgentQuarantine,
          serverId,
          'server',
          { taskIds: retryTaskIds },
        );
      },
    );
    this.dispatcher.wake();
    this.workflowFinalizers.wake();
    return { taskIds };
  }
}
