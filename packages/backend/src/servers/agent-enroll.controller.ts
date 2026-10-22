import { Body, Controller, HttpCode, HttpException, HttpStatus, Post, Req } from '@nestjs/common';
import { zAgentEnrollRequest, type AgentEnrollResponse } from '@nyabase/common';
import { Public } from '../iam/decorators.js';
import { AgentEnrollmentService } from './agent-enrollment.service.js';

const WINDOW_MS = 10 * 60_000;
const MAX_ATTEMPTS_PER_WINDOW = 30;
const MAX_TRACKED_ADDRESSES = 4_096;

/** Where a host agent trades its one-time enrollment token for a credential. */
@Controller('agent')
export class AgentEnrollController {
  private readonly attempts = new Map<string, { count: number; windowStartedAt: number }>();

  constructor(private readonly enrollment: AgentEnrollmentService) {}

  @Public()
  @Post('enroll')
  @HttpCode(200)
  enroll(@Body() body: unknown, @Req() request: { ip?: string }): Promise<AgentEnrollResponse> {
    this.consumeAttempt(request.ip ?? 'unknown');
    return this.enrollment.enroll(zAgentEnrollRequest.parse(body));
  }

  private consumeAttempt(address: string): void {
    const now = Date.now();
    for (const [key, entry] of this.attempts) {
      if (now - entry.windowStartedAt >= WINDOW_MS) this.attempts.delete(key);
    }
    const entry = this.attempts.get(address);
    if (!entry) {
      if (this.attempts.size >= MAX_TRACKED_ADDRESSES) {
        throw new HttpException('Enrollment is temporarily unavailable', HttpStatus.TOO_MANY_REQUESTS);
      }
      this.attempts.set(address, { count: 1, windowStartedAt: now });
      return;
    }
    entry.count += 1;
    if (entry.count > MAX_ATTEMPTS_PER_WINDOW) {
      throw new HttpException('Too many enrollment attempts', HttpStatus.TOO_MANY_REQUESTS);
    }
  }
}
