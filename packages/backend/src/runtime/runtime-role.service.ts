import { Injectable } from '@nestjs/common';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';

const NEST_RUNTIME_ROLES = ['all', 'api', 'worker'] as const;

export type RuntimeRole = (typeof NEST_RUNTIME_ROLES)[number];

function isNestRuntimeRole(value: string): value is RuntimeRole {
  return (NEST_RUNTIME_ROLES as readonly string[]).includes(value);
}

@Injectable()
export class RuntimeRoleService {
  readonly role: RuntimeRole;

  constructor(config: NyabaseConfigService) {
    const role = config.get<string>('runtime.role');
    if (!isNestRuntimeRole(role)) {
      throw new Error(
        `Unsupported Nest runtime.role=${role}; expected all, api, or worker`,
      );
    }
    this.role = role;
  }

  servesApi(): boolean {
    return this.role === 'all' || this.role === 'api';
  }

  servesProxySockets(): boolean {
    return this.role === 'all' || this.role === 'api';
  }

  runsWorker(): boolean {
    return this.role === 'all' || this.role === 'worker';
  }

  requiresRedisAvailability(): boolean {
    return this.role === 'api';
  }

  allowsHttpPath(path: string): boolean {
    return this.servesApi() || path === '/api/health/live' || path === '/api/health/ready';
  }
}
