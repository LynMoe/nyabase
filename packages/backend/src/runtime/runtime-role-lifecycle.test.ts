import { describe, expect, it, vi } from 'vitest';
import type { NyabaseConfigService } from '../config/nyabase-config.service.js';
import { AgentTaskDispatcherService } from '../agent-tasks/agent-task-dispatcher.service.js';
import { AgentTaskRetentionService } from '../agent-tasks/agent-task-retention.service.js';
import { WorkflowFinalizerWorkerService } from '../agent-tasks/workflow-finalizer-worker.service.js';
import { AgentGateway } from '../gateway/agent-gateway.js';
import { MetricsWriter } from '../metrics/metrics-writer.js';
import type { RuntimeRoleService } from './runtime-role.service.js';
import { AppService } from '../app.service.js';

function role(kind: 'api' | 'gateway' | 'worker'): RuntimeRoleService {
  return {
    role: kind,
    servesApi: () => kind === 'api',
    servesGateway: () => kind === 'gateway',
    runsWorker: () => kind === 'worker',
  } as RuntimeRoleService;
}

describe('runtime role lifecycle gates', () => {
  it('does not start gateway dispatch or any worker loops in the API role', async () => {
    const api = role('api');
    const redis = {
      publish: vi.fn().mockResolvedValue(true),
    };
    const dispatcher = new AgentTaskDispatcherService(api, redis as never, {} as never);
    const finalizer = new WorkflowFinalizerWorkerService(
      {} as never,
      {} as never,
      api,
    );
    const retention = new AgentTaskRetentionService({} as never, api);

    dispatcher.onModuleInit();
    finalizer.onModuleInit();
    retention.onModuleInit();

    expect((dispatcher as unknown as { timer: unknown }).timer).toBeNull();
    expect((finalizer as unknown as { timer: unknown }).timer).toBeNull();
    expect((retention as unknown as { timer: unknown }).timer).toBeNull();

    dispatcher.wake();
    finalizer.wake();
    expect(redis.publish).toHaveBeenCalledWith('dispatch', 'wake');
  });

  it.each([
    ['api' as const, 1],
    ['worker' as const, 0],
  ])(
    'does not execute socket-owner bootstrap side effects in the %s role',
    async (kind, expectedSubscriptions) => {
      const taskDispatcher = { registerTransport: vi.fn() };
      const redis = {
        gatewayId: 'gateway:00000000-0000-4000-8000-000000000001',
        subscribeAddressedRpc: vi.fn().mockResolvedValue(async () => undefined),
      };
      const constructorArgs = Array.from({ length: 25 }, () => ({}));
      constructorArgs[9] = taskDispatcher;
      constructorArgs[21] = role(kind);
      constructorArgs[22] = redis;
      const gateway = Reflect.construct(AgentGateway, constructorArgs) as AgentGateway;

      await expect(gateway.onModuleInit()).resolves.toBeUndefined();
      expect(taskDispatcher.registerTransport).not.toHaveBeenCalled();
      expect(redis.subscribeAddressedRpc).toHaveBeenCalledTimes(expectedSubscriptions);
    },
  );

  it('does not start the metric ingestion loop outside gateway roles', () => {
    const writer = new MetricsWriter({
      get: () => 'http://vmagent',
    } as unknown as NyabaseConfigService, role('worker'));

    expect((writer as unknown as { flushTimer: unknown }).flushTimer).toBeNull();
  });

  it('unsubscribes a dispatcher subscription that resolves after destroy', async () => {
    let resolveSubscribe!: (unsubscribe: () => Promise<void>) => void;
    const unsubscribe = vi.fn().mockResolvedValue(undefined);
    const redis = {
      subscribe: vi.fn(() => new Promise<() => Promise<void>>((resolve) => {
        resolveSubscribe = resolve;
      })),
    };
    const dispatcher = new AgentTaskDispatcherService(
      role('gateway'),
      redis as never,
      {} as never,
    );
    dispatcher.onModuleInit();

    const destroyed = dispatcher.onModuleDestroy();
    resolveSubscribe(unsubscribe);
    await destroyed;

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect((dispatcher as unknown as {
      unsubscribeRedis: unknown;
    }).unsubscribeRedis).toBeNull();
  });

  it('contains a rejected dispatcher subscription without an unhandled rejection', async () => {
    const redis = {
      subscribe: vi.fn().mockRejectedValue(new Error('redis unavailable')),
    };
    const dispatcher = new AgentTaskDispatcherService(
      role('gateway'),
      redis as never,
      {} as never,
    );
    dispatcher.onModuleInit();
    await dispatcher.onModuleDestroy();
    expect(redis.subscribe).toHaveBeenCalledOnce();
  });

  it('does not leak an addressed RPC subscription that resolves after Gateway destroy', async () => {
    let resolveSubscribe!: (unsubscribe: () => Promise<void>) => void;
    const unsubscribe = vi.fn().mockResolvedValue(undefined);
    const redis = {
      gatewayId: 'gateway:00000000-0000-4000-8000-000000000001',
      subscribeAddressedRpc: vi.fn(
        () => new Promise<() => Promise<void>>((resolve) => {
          resolveSubscribe = resolve;
        }),
      ),
    };
    const constructorArgs = Array.from({ length: 25 }, () => ({}));
    constructorArgs[21] = role('api');
    constructorArgs[22] = redis;
    const gateway = Reflect.construct(AgentGateway, constructorArgs) as AgentGateway;
    await gateway.onModuleInit();

    gateway.onModuleDestroy();
    resolveSubscribe(unsubscribe);
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());
    expect((gateway as unknown as {
      unsubscribeAgentRpc: unknown;
    }).unsubscribeAgentRpc).toBeNull();
  });

  it('contains a rejected addressed RPC subscription without an unhandled rejection', async () => {
    const redis = {
      gatewayId: 'gateway:00000000-0000-4000-8000-000000000001',
      subscribeAddressedRpc: vi.fn().mockRejectedValue(
        new Error('redis unavailable'),
      ),
    };
    const constructorArgs = Array.from({ length: 25 }, () => ({}));
    constructorArgs[21] = role('api');
    constructorArgs[22] = redis;
    const gateway = Reflect.construct(AgentGateway, constructorArgs) as AgentGateway;

    await gateway.onModuleInit();
    gateway.onModuleDestroy();
    await vi.waitFor(() =>
      expect((gateway as unknown as {
        routedRpcSubscription: unknown;
      }).routedRpcSubscription).toBeNull());
  });

  it('does not seed administrative bootstrap data outside API roles', async () => {
    const users = { ensureAdminExists: vi.fn() };
    const groups = { ensureSystemGroups: vi.fn() };
    const service = new AppService(
      users as never,
      groups as never,
      role('worker'),
    );

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(groups.ensureSystemGroups).not.toHaveBeenCalled();
    expect(users.ensureAdminExists).not.toHaveBeenCalled();
  });
});
