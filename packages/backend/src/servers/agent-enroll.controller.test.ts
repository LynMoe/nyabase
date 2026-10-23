import { HttpException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentEnrollController,
  ENROLL_ATTEMPT_WINDOW_MS,
  MAX_ENROLL_ATTEMPTS_PER_WINDOW,
  MAX_TRACKED_ENROLL_ADDRESSES,
} from './agent-enroll.controller.js';
import type { AgentEnrollmentService } from './agent-enrollment.service.js';

const BODY = { enrollmentToken: 'nyae.token', hostname: 'worker-1' };

function controller() {
  const enroll = vi.fn(async () => ({ serverId: '11111111-1111-4111-8111-111111111111', credential: 'nyak.x' }));
  return { enroll, controller: new AgentEnrollController({ enroll } as unknown as AgentEnrollmentService) };
}

function attempt(target: AgentEnrollController, ip: string): number {
  try {
    void target.enroll(BODY, { ip });
    return 200;
  } catch (error) {
    if (error instanceof HttpException) return error.getStatus();
    throw error;
  }
}

describe('agent enrollment rate limit', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('limits each address per window and forgets it after the window', () => {
    const { controller: target, enroll } = controller();
    for (let index = 0; index < MAX_ENROLL_ATTEMPTS_PER_WINDOW; index += 1) {
      expect(attempt(target, '203.0.113.7')).toBe(200);
    }
    expect(attempt(target, '203.0.113.7')).toBe(429);
    expect(attempt(target, '::ffff:203.0.113.7')).toBe(429);
    expect(attempt(target, '203.0.113.8')).toBe(200);
    expect(enroll).toHaveBeenCalledTimes(MAX_ENROLL_ATTEMPTS_PER_WINDOW + 1);
    vi.advanceTimersByTime(ENROLL_ATTEMPT_WINDOW_MS);
    expect(attempt(target, '203.0.113.7')).toBe(200);
  });

  it('counts a whole IPv6 /64 as one client', () => {
    const { controller: target } = controller();
    for (let index = 0; index < MAX_ENROLL_ATTEMPTS_PER_WINDOW; index += 1) {
      expect(attempt(target, `2001:db8:1:2::${(index + 1).toString(16)}`)).toBe(200);
    }
    expect(attempt(target, '2001:db8:1:2:ffff:ffff:ffff:ffff')).toBe(429);
    expect(attempt(target, '2001:db8:1:3::1')).toBe(200);
  });

  it('keeps admitting new clients when the table is full', () => {
    const { controller: target } = controller();
    for (let index = 0; index < MAX_TRACKED_ENROLL_ADDRESSES + 10; index += 1) {
      expect(attempt(target, `2001:db8:${(index >> 16).toString(16)}:${(index & 0xffff).toString(16)}::1`)).toBe(200);
    }
    expect(attempt(target, '198.51.100.1')).toBe(200);
  });
});
