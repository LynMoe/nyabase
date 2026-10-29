import { Body, Controller, HttpCode, HttpException, HttpStatus, Post, Req } from '@nestjs/common';
import { zAgentEnrollRequest, type AgentEnrollResponse } from '@nyabase/common';
import { Public } from '../iam/decorators.js';
import { clientAddressBucket, LoginAttemptLimiter } from '../iam/login-throttling.js';
import { AgentEnrollmentService } from './agent-enrollment.service.js';

export const ENROLL_ATTEMPT_WINDOW_MS = 10 * 60_000;
export const MAX_ENROLL_ATTEMPTS_PER_WINDOW = 30;
export const MAX_TRACKED_ENROLL_ADDRESSES = 4_096;

/** Where a host agent trades its one-time enrollment token for a credential. */
@Controller('agent')
export class AgentEnrollController {
  /**
   * Every attempt counts against its client bucket (IPv6 by /48, so one site
   * cannot rotate addresses). A full table evicts its least recently used
   * bucket instead of refusing new ones, so many addresses cannot lock
   * enrollment for everybody.
   */
  private readonly attempts = new LoginAttemptLimiter(
    () => Date.now(),
    MAX_TRACKED_ENROLL_ADDRESSES,
    ENROLL_ATTEMPT_WINDOW_MS,
  );

  constructor(private readonly enrollment: AgentEnrollmentService) {}

  @Public()
  @Post('enroll')
  @HttpCode(200)
  enroll(@Body() body: unknown, @Req() request: { ip?: string }): Promise<AgentEnrollResponse> {
    const limit = { key: clientAddressBucket(request.ip), limit: MAX_ENROLL_ATTEMPTS_PER_WINDOW };
    if (!this.attempts.reserve([limit])) {
      throw new HttpException('Too many enrollment attempts', HttpStatus.TOO_MANY_REQUESTS);
    }
    return this.enrollment.enroll(zAgentEnrollRequest.parse(body));
  }
}
