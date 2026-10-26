import { Controller, Get } from '@nestjs/common';
import { Role, type RejectedAgentCredentialDto } from '@nyabase/common';
import { RequireRole } from '../iam/decorators.js';
import { AgentCredentialRejections } from '../incus/agent-credentials.js';

/**
 * Agents dialing in with a credential this database does not accept (hosts
 * enrolled after a restored backup, stale agents after a re-enrollment).
 * They name server ids that may not exist here, so this is no servers route.
 */
@Controller('admin/agent-rejections')
export class AdminAgentRejectionsController {
  constructor(private readonly rejections: AgentCredentialRejections) {}

  @Get()
  @RequireRole(Role.Admin)
  list(): RejectedAgentCredentialDto[] {
    return this.rejections.list();
  }
}
