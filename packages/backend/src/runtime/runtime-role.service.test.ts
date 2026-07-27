import { describe, expect, it } from 'vitest';
import type { NyabaseConfigService } from '../config/nyabase-config.service.js';
import { RuntimeRoleService, type RuntimeRole } from './runtime-role.service.js';

function service(role: RuntimeRole): RuntimeRoleService {
  return new RuntimeRoleService({
    get: () => role,
  } as unknown as NyabaseConfigService);
}

describe('RuntimeRoleService', () => {
  it.each([
    ['all', true, true, true],
    ['api', true, false, false],
    ['gateway', false, true, false],
    ['worker', false, false, true],
  ] as const)('maps %s to API/Gateway/Worker responsibilities', (role, api, gateway, worker) => {
    const runtime = service(role);
    expect(runtime.servesApi()).toBe(api);
    expect(runtime.servesGateway()).toBe(gateway);
    expect(runtime.runsWorker()).toBe(worker);
  });

  it('exposes health and exact live-connection administration on the Gateway role', () => {
    const runtime = service('gateway');
    expect(runtime.allowsHttpPath('/api/health/live')).toBe(true);
    expect(runtime.allowsHttpPath('/api/health/ready')).toBe(true);
    expect(runtime.allowsHttpPath('/api/admin/ssh-proxy/status')).toBe(true);
    expect(runtime.allowsHttpPath('/api/admin/ssh-proxy/host-key/rotate')).toBe(true);
    expect(runtime.allowsHttpPath('/api/admin/http-proxy/status')).toBe(true);
    expect(runtime.allowsHttpPath('/api/admin/http-proxy/domain-pools')).toBe(false);
    expect(runtime.allowsHttpPath('/api/users')).toBe(false);
    expect(runtime.allowsHttpPath('/')).toBe(false);
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
