import { describe, expect, it, vi } from 'vitest';
import { IntentKind, IntentResourceType } from '@nyabase/common';
import { ContainerSshConvergenceService } from './container-ssh-convergence.service.js';

describe('ContainerSshConvergenceService', () => {
  it('bumps generation and creates container.update when syncing user keys', async () => {
    const containerId = '11111111-1111-4111-8111-111111111111';
    const serverId = '22222222-2222-4222-8222-222222222222';
    const createPending = vi.fn().mockResolvedValue({ id: 'intent-1' });
    const wake = vi.fn();
    const forUpdate = {
      executeTakeFirst: vi.fn().mockResolvedValue({
        id: containerId,
        server_id: serverId,
        generation: 3,
        lifecycle_phase: 'active',
      }),
    };
    const returning = {
      executeTakeFirst: vi.fn().mockResolvedValue({
        id: containerId,
        server_id: serverId,
        generation: 4,
      }),
    };
    const whereGeneration = {
      returning: vi.fn().mockReturnValue(returning),
    };
    const updateWhereId = {
      where: vi.fn().mockReturnValue(whereGeneration),
    };
    const updateSet = {
      where: vi.fn().mockReturnValue(updateWhereId),
    };
    const transaction = {
      selectFrom: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            forUpdate: vi.fn().mockReturnValue(forUpdate),
          }),
        }),
      }),
      updateTable: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue(updateSet),
      }),
    };
    const database = {
      selectFrom: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              execute: vi.fn().mockResolvedValue([{ id: containerId }]),
            }),
          }),
        }),
      }),
      transaction: vi.fn().mockReturnValue({
        setIsolationLevel: vi.fn().mockReturnValue({
          execute: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) =>
            callback(transaction)),
        }),
      }),
    };

    const service = new ContainerSshConvergenceService(
      database as never,
      { createPending } as never,
      { wake } as never,
    );

    await service.reconcileUser('33333333-3333-4333-8333-333333333333');

    expect(createPending).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: IntentKind.ContainerUpdate,
        resourceType: IntentResourceType.Container,
        resourceId: containerId,
        serverId,
        targetGeneration: 4,
        request: { operation: 'sync_user_ssh_keys' },
      }),
      transaction,
    );
    expect(wake).toHaveBeenCalledWith(expect.objectContaining({
      resourceType: IntentResourceType.Container,
      resourceId: containerId,
      serverId,
      reason: 'intent',
    }));
  });

  it('repair bumps generation instead of wake-only', async () => {
    const containerId = '11111111-1111-4111-8111-111111111111';
    const serverId = '22222222-2222-4222-8222-222222222222';
    const createPending = vi.fn().mockResolvedValue({ id: 'intent-2' });
    const wake = vi.fn();
    const transaction = {
      selectFrom: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            forUpdate: vi.fn().mockReturnValue({
              executeTakeFirst: vi.fn().mockResolvedValue({
                id: containerId,
                server_id: serverId,
                generation: 1,
                lifecycle_phase: 'active',
              }),
            }),
          }),
        }),
      }),
      updateTable: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockReturnValue({
                executeTakeFirst: vi.fn().mockResolvedValue({
                  id: containerId,
                  server_id: serverId,
                  generation: 2,
                }),
              }),
            }),
          }),
        }),
      }),
    };
    const database = {
      transaction: vi.fn().mockReturnValue({
        setIsolationLevel: vi.fn().mockReturnValue({
          execute: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) =>
            callback(transaction)),
        }),
      }),
    };
    const service = new ContainerSshConvergenceService(
      database as never,
      { createPending } as never,
      { wake } as never,
    );

    await expect(service.repairContainer(containerId)).resolves.toEqual({ woken: true });
    expect(createPending).toHaveBeenCalledWith(
      expect.objectContaining({
        request: { operation: 'repair_ssh' },
        targetGeneration: 2,
      }),
      transaction,
    );
  });
});
