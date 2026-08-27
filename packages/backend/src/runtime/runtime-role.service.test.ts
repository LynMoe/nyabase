import { describe, expect, it } from 'vitest';
import type { NyabaseConfigService } from '../config/nyabase-config.service.js';
import { RuntimeRoleService } from './runtime-role.service.js';

function service(role: string): RuntimeRoleService {
  return new RuntimeRoleService({
    get: () => role,
  } as unknown as NyabaseConfigService);
}

describe('RuntimeRoleService', () => {
  it.each([
    ['all', true, true, true, false],
    ['api', true, true, false, true],
    ['worker', false, false, true, false],
  ] as const)(
    'maps %s to API/proxy-socket/worker/redis-required responsibilities',
    (role, api, proxySockets, worker, redisRequired) => {
      const runtime = service(role);
      expect(runtime.servesApi()).toBe(api);
      expect(runtime.servesProxySockets()).toBe(proxySockets);
      expect(runtime.runsWorker()).toBe(worker);
      expect(runtime.requiresRedisAvailability()).toBe(redisRequired);
    },
  );

  it('fails boot when runtime.role is not a Nest process role', () => {
    for (const role of ['gateway', 'node-exporter', 'ssh-proxy', 'http-proxy', 'unknown']) {
      expect(() => service(role)).toThrow(/Unsupported Nest runtime\.role=/);
    }
  });

  it('exposes only process health over HTTP for the Worker role', () => {
    const runtime = service('worker');
    expect(runtime.allowsHttpPath('/api/health/live')).toBe(true);
    expect(runtime.allowsHttpPath('/api/health/ready')).toBe(true);
    expect(runtime.allowsHttpPath('/api/admin/ssh-proxy/status')).toBe(false);
    expect(runtime.allowsHttpPath('/api/admin/http-proxy/status')).toBe(false);
    expect(runtime.allowsHttpPath('/api/users')).toBe(false);
    expect(runtime.allowsHttpPath('/')).toBe(false);
  });
});
