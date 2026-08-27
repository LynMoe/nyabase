import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GrantExpiryWorkerService } from './grant-expiry-worker.service.js';
import { SYSTEM_ACTOR_USERNAME } from '../groups/groups.service.js';

const SYSTEM_ACTOR_ID = '00000000-0000-4000-8000-000000000409';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GrantExpiryWorkerService system actor', () => {
  it('runs a pass with no administrators when nyabase-system exists', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service, lookups } = createWorker({ systemActorId: SYSTEM_ACTOR_ID });

    await service.process();

    expect(lookups.usernames).toEqual([SYSTEM_ACTOR_USERNAME]);
    expect(lookups.joinedAdministrators).toBe(false);
    expect(warn.mock.calls.flat().join('\n')).not.toMatch(/administrator/i);
  });

  it('returns a stable actor id across passes', async () => {
    const { service, lookups } = createWorker({ systemActorId: SYSTEM_ACTOR_ID });

    await service.process();
    await service.process();

    expect(lookups.resolvedIds).toEqual([SYSTEM_ACTOR_ID, SYSTEM_ACTOR_ID]);
  });

  it('skips only when nyabase-system is missing, not because humans are absent', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service } = createWorker({ systemActorId: null });

    await service.process();

    expect(warn).toHaveBeenCalledWith(
      'Grant expiry worker skipped: nyabase-system actor is missing',
    );
  });
});

function createWorker(options: { systemActorId: string | null }) {
  const lookups = {
    usernames: [] as unknown[],
    resolvedIds: [] as Array<string | null>,
    joinedAdministrators: false,
  };
  const executeQuery = vi.fn(async () => ({ rows: [] }));
  const executor = {
    transformQuery: (node: unknown) => node,
    compileQuery: () => ({ sql: 'select 1', parameters: [] }),
    executeQuery,
    withPlugins() {
      return this;
    },
  };
  const selectFrom = vi.fn((table: string) => {
    const filters: Array<{ key: string; op: string; value: unknown }> = [];
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    builder.innerJoin = (...args: unknown[]) => {
      if (String(args[0]).includes('group')) lookups.joinedAdministrators = true;
      return builder;
    };
    builder.leftJoin = chain;
    builder.select = chain;
    builder.selectAll = chain;
    builder.orderBy = chain;
    builder.where = (key: string, op: string, value: unknown) => {
      filters.push({ key, op, value });
      if (String(value) === 'administrators') lookups.joinedAdministrators = true;
      return builder;
    };
    builder.executeTakeFirst = async () => {
      if (String(table).includes('iam.users')) {
        const username = filters.find((filter) => String(filter.key).includes('username'))
          ?.value;
        lookups.usernames.push(username);
        lookups.resolvedIds.push(options.systemActorId);
        return options.systemActorId ? { id: options.systemActorId } : undefined;
      }
      return undefined;
    };
    builder.execute = async () => [];
    return builder;
  });

  const service = new GrantExpiryWorkerService(
    {
      selectFrom,
      getExecutor: () => executor,
      executeQuery,
    } as never,
    { run: vi.fn() } as never,
    { runsWorker: () => true } as never,
    {} as never,
    {} as never,
    { append: vi.fn() } as never,
  );
  return { service, lookups, executeQuery };
}
