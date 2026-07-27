import { Injectable } from '@nestjs/common';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';

export type RuntimeRole = 'all' | 'api' | 'gateway' | 'worker';

@Injectable()
export class RuntimeRoleService {
  readonly role: RuntimeRole;

  constructor(config: NyabaseConfigService) {
    this.role = config.get<RuntimeRole>('runtime.role');
  }

  servesApi(): boolean {
    return this.role === 'all' || this.role === 'api';
  }

  servesGateway(): boolean {
    return this.role === 'all' || this.role === 'gateway';
  }

  runsWorker(): boolean {
    return this.role === 'all' || this.role === 'worker';
  }

  requiresRedisAvailability(): boolean {
    return this.role === 'api' || this.role === 'gateway';
  }

  allowsHttpPath(path: string): boolean {
    if (this.servesApi() || path === '/api/health/live' || path === '/api/health/ready') {
      return true;
    }
    if (!this.servesGateway()) return false;
    return path.startsWith('/api/admin/ssh-proxy/')
      || path === '/api/admin/http-proxy/status';
  }
}
