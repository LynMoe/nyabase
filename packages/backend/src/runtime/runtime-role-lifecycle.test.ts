import { describe, expect, it, vi } from 'vitest';
import { AppService } from '../app.service.js';
import {
  ReconcileWorkerService,
  type ReconcilerRegistry,
} from './reconcile-worker.service.js';
import type { RuntimeRoleService } from './runtime-role.service.js';

function role(kind: 'api' | 'worker'): RuntimeRoleService {
  return {
    role: kind,
    servesApi: () => kind === 'api',
    servesProxySockets: () => kind === 'api',
    runsWorker: () => kind === 'worker',
  } as RuntimeRoleService;
}

describe('runtime role lifecycle gates', () => {
  it('does not start the reconciler loop in the API role', () => {
    const worker = new ReconcileWorkerService(
      role('api'),
      { listPending: vi.fn() } as never,
      {} as never,
      [] as ReconcilerRegistry,
    );
    worker.onModuleInit();
    expect((worker as unknown as { scanTimer?: unknown }).scanTimer).toBeUndefined();
  });

  it('starts and cleans up only the new reconciliation loop in the worker role', async () => {
    const worker = new ReconcileWorkerService(
      role('worker'),
      { listPending: vi.fn().mockResolvedValue({ items: [], nextCursor: null }) } as never,
      { reapExpired: vi.fn().mockResolvedValue(0) } as never,
      [] as ReconcilerRegistry,
    );
    worker.onModuleInit();
    expect((worker as unknown as { scanTimer?: unknown }).scanTimer).toBeDefined();
    await worker.onModuleDestroy();
    expect((worker as unknown as { scanTimer?: unknown }).scanTimer).toBeUndefined();
  });

  it('does not seed administrative bootstrap data outside API roles', async () => {
    const groups = {
      ensureSystemGroups: vi.fn(),
      ensureUserInSystemGroup: vi.fn(),
    };
    const users = {
      ensureAdminExists: vi.fn(),
    };
    const service = new AppService(role('worker'), groups as never, users as never);

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(groups.ensureSystemGroups).not.toHaveBeenCalled();
    expect(users.ensureAdminExists).not.toHaveBeenCalled();
  });

  it('keeps the metric writer disabled outside proxy-socket roles', () => {
    expect(role('worker').servesProxySockets()).toBe(false);
  });
});
