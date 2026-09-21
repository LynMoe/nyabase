import { describe, expect, it, vi } from 'vitest';
import { IntentKind, IntentResourceType, IntentStatus } from '@nyabase/common';
import { IntentRepository, isRestartIntent, isUserRetryIntent } from './intent.repository.js';

describe('isRestartIntent', () => {
  it('is only container.power with action restart', () => {
    expect(isRestartIntent(IntentKind.ContainerPower, { action: 'restart' })).toBe(true);
    expect(isRestartIntent(IntentKind.ContainerPower, { action: 'start' })).toBe(false);
    expect(isRestartIntent(IntentKind.ContainerUpdate, { action: 'restart' })).toBe(false);
    expect(isRestartIntent(IntentKind.ContainerPower, null)).toBe(false);
  });
});

const volumeId = '11111111-1111-4111-8111-111111111111';
const containerId = '22222222-2222-4222-8222-222222222222';
const serverId = '33333333-3333-4333-8333-333333333333';
const ensureId = '44444444-4444-4444-8444-444444444444';
const updateId = '55555555-5555-4555-8555-555555555555';
const olderId = '66666666-6666-4666-8666-666666666666';
const newerId = '77777777-7777-4777-8777-777777777777';
const retryId = '88888888-8888-4888-8888-888888888888';

describe('isUserRetryIntent', () => {
  it('detects retryOf on the request payload', () => {
    expect(isUserRetryIntent({ retryOf: retryId })).toBe(true);
    expect(isUserRetryIntent({ operation: 'resize' })).toBe(false);
    expect(isUserRetryIntent({ retryOf: '' })).toBe(false);
    expect(isUserRetryIntent(null)).toBe(false);
  });
});

type IntentRow = {
  id: string;
  kind: string;
  resource_type: string;
  resource_id: string;
  server_id: string | null;
  requested_by: string | null;
  request_json: Record<string, unknown> | null;
  target_generation: number;
  baseline_json: Record<string, unknown> | null;
  status: string;
  failure_code: string | null;
  failure_json: unknown;
  attempt_count: number;
  next_attempt_at: Date | null;
  created_at: Date;
  settled_at: Date | null;
  blocked_by_intent_id: string | null;
};

function row(overrides: Partial<IntentRow>): IntentRow {
  return {
    id: olderId,
    kind: IntentKind.VolumeEnsure,
    resource_type: IntentResourceType.Volume,
    resource_id: volumeId,
    server_id: serverId,
    requested_by: null,
    request_json: { operation: 'ensure_attachment', idempotencyKey: 'ensure_attachment' },
    target_generation: 1,
    baseline_json: null,
    status: IntentStatus.Pending,
    failure_code: null,
    failure_json: null,
    attempt_count: 0,
    next_attempt_at: null,
    created_at: new Date('2026-01-01T00:00:02.000Z'),
    settled_at: null,
    blocked_by_intent_id: null,
    ...overrides,
  };
}

function matchesFilter(
  item: IntentRow,
  filter: { col?: string; op?: string; val?: unknown; type?: string; parts?: unknown[] },
): boolean {
  if (filter.type === 'or') {
    return (filter.parts ?? []).some((part) => matchesFilter(item, part as never));
  }
  if (!filter.col) return true;
  const value = (item as unknown as Record<string, unknown>)[filter.col];
  if (filter.op === '=' || filter.op === undefined) return value === filter.val;
  if (filter.op === 'is') return filter.val === null ? value === null : value === filter.val;
  if (filter.op === 'in') return Array.isArray(filter.val) && filter.val.includes(value);
  if (filter.op === '<=') {
    if (filter.col === 'target_generation') return Number(value) <= Number(filter.val);
    if (value instanceof Date && filter.val instanceof Date) return value.getTime() <= filter.val.getTime();
  }
  return true;
}

function makeExecutor(seed: IntentRow[]) {
  const store = { intents: [...seed] };
  const chain = (table: string, mode: 'select' | 'update' | 'insert') => {
    const state: {
      filters: Array<{ col?: string; op?: string; val?: unknown; type?: string; parts?: unknown[] }>;
      orders: Array<{ col: string; dir: string }>;
      limit?: number;
      values?: Record<string, unknown>;
      setValues?: Record<string, unknown>;
      skipBlocked: boolean;
    } = { filters: [], orders: [], skipBlocked: false };
    const query: Record<string, unknown> = {};
    const applyWhere = (col: unknown, op?: unknown, val?: unknown) => {
      if (typeof col === 'function') {
        const expression = Object.assign(
          (field: string, operator: string, value: unknown) => ({
            type: 'filter',
            col: field,
            op: operator,
            val: value,
          }),
          {
            or: (parts: unknown[]) => {
              const blocked = parts.some((part) => part && typeof part === 'object' && 'sql' in (part as object));
              if (blocked) state.skipBlocked = true;
              return { type: 'or', parts };
            },
          },
        );
        const result = col(expression) as { type?: string; col?: string; op?: string; val?: unknown };
        if (result?.type === 'or') {
          const readyAt = (result as { parts?: Array<{ col?: string }> }).parts
            ?.some((part) => part.col === 'next_attempt_at');
          if (readyAt) state.filters.push(result);
          else state.skipBlocked = true;
        } else if (result?.col) {
          state.filters.push(result);
        }
        return query;
      }
      state.filters.push({ type: 'filter', col: col as string, op: op as string, val });
      return query;
    };
    query.selectAll = () => query;
    query.select = () => query;
    query.where = applyWhere;
    query.orderBy = (col: unknown, dir = 'asc') => {
      state.orders.push({
        col: typeof col === 'string' ? col : 'ready_at',
        dir: String(dir),
      });
      return query;
    };
    query.limit = (value: number) => {
      state.limit = value;
      return query;
    };
    query.forUpdate = () => query;
    query.values = (value: Record<string, unknown>) => {
      state.values = value;
      return query;
    };
    query.set = (value: Record<string, unknown>) => {
      state.setValues = value;
      return query;
    };
    query.returningAll = () => query;
    query.returning = () => query;
    const selected = () => {
      let rows = store.intents.filter((item) => state.filters.every((filter) => matchesFilter(item, filter)));
      if (state.skipBlocked) {
        rows = rows.filter((item) => {
          if (!item.blocked_by_intent_id) return true;
          const pred = store.intents.find((candidate) => candidate.id === item.blocked_by_intent_id);
          return pred?.status === IntentStatus.Succeeded;
        });
      }
      if (state.orders.some((order) => order.col === 'ready_at')) {
        rows = [...rows].sort((left, right) => {
          const leftReady = (left.next_attempt_at ?? left.created_at).getTime();
          const rightReady = (right.next_attempt_at ?? right.created_at).getTime();
          if (leftReady !== rightReady) return leftReady - rightReady;
          if (left.created_at.getTime() !== right.created_at.getTime()) {
            return left.created_at.getTime() - right.created_at.getTime();
          }
          return left.id.localeCompare(right.id);
        });
      } else if (state.orders[0]?.col === 'created_at' && state.orders[0]?.dir === 'desc') {
        rows = [...rows].sort((left, right) => {
          if (left.created_at.getTime() !== right.created_at.getTime()) {
            return right.created_at.getTime() - left.created_at.getTime();
          }
          return right.id.localeCompare(left.id);
        });
      }
      return state.limit ? rows.slice(0, state.limit) : rows;
    };
    query.execute = async () => {
      if (mode === 'update' && state.setValues) {
        const matched = store.intents.filter((item) =>
          state.filters.every((filter) => matchesFilter(item, filter)));
        for (const item of matched) {
          Object.assign(item, state.setValues);
          if (typeof state.setValues.status === 'string') item.status = state.setValues.status;
          if (state.setValues.settled_at) item.settled_at = new Date();
        }
        return matched;
      }
      if (mode === 'insert' && state.values) {
        const inserted = row({
          id: String(state.values.id),
          kind: String(state.values.kind),
          resource_type: String(state.values.resource_type),
          resource_id: String(state.values.resource_id),
          server_id: (state.values.server_id as string | null) ?? null,
          request_json: state.values.request_json
            ? JSON.parse(String(state.values.request_json)) as Record<string, unknown>
            : null,
          target_generation: Number(state.values.target_generation),
          status: String(state.values.status),
          created_at: new Date(),
          blocked_by_intent_id: (state.values.blocked_by_intent_id as string | null) ?? null,
        });
        store.intents.push(inserted);
        return [inserted];
      }
      return selected();
    };
    query.executeTakeFirst = async () => {
      const rows = await (query.execute as () => Promise<IntentRow[]>)();
      return rows[0];
    };
    query.executeTakeFirstOrThrow = async () => {
      const first = await (query.executeTakeFirst as () => Promise<IntentRow | undefined>)();
      if (!first) throw new Error(`no ${table} row`);
      return first;
    };
    return query;
  };
  return {
    store,
    db: {
      executeQuery: vi.fn(async () => ({ rows: [], numAffectedRows: 0n })),
      getExecutor() {
        return this;
      },
      transformQuery: (node: unknown) => node,
      compileQuery: (query: unknown) => query,
      selectFrom: (table: string) => chain(table, 'select'),
      insertInto: (table: string) => chain(table, 'insert'),
      updateTable: (table: string) => chain(table, 'update'),
    },
  };
}

describe('intent pending queue and settle wake', () => {
  it('lists HTTP history newest-first and worker pending FIFO, skipping unfinished blocked_by', async () => {
    const ready = new Date('2026-01-01T00:00:10.000Z');
    const { db } = makeExecutor([
      row({
        id: newerId,
        created_at: new Date('2026-01-01T00:00:03.000Z'),
      }),
      row({
        id: olderId,
        created_at: new Date('2026-01-01T00:00:01.000Z'),
      }),
      row({
        id: retryId,
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        next_attempt_at: new Date('2026-01-01T00:00:04.000Z'),
      }),
      row({
        id: updateId,
        kind: IntentKind.ContainerUpdate,
        resource_type: IntentResourceType.Container,
        resource_id: containerId,
        created_at: new Date('2026-01-01T00:00:02.000Z'),
        blocked_by_intent_id: ensureId,
      }),
      row({
        id: ensureId,
        created_at: new Date('2026-01-01T00:00:02.000Z'),
        status: IntentStatus.Pending,
      }),
    ]);
    const repository = new IntentRepository(db as never);
    const history = await repository.list({ limit: 10 });
    expect(history.items.map((item) => item.id)).toEqual([
      newerId,
      updateId,
      ensureId,
      olderId,
      retryId,
    ]);

    const pending = await repository.listPending({ limit: 10, readyAt: ready });
    expect(pending.items.map((item) => item.id)).toEqual([olderId, ensureId, newerId, retryId]);
    expect(pending.items.some((item) => item.id === updateId)).toBe(false);
  });

  it('wakes the blocked container when a volume ensure settles succeeded', async () => {
    const wake = { wake: vi.fn() };
    const { db } = makeExecutor([
      row({
        id: ensureId,
        kind: IntentKind.VolumeEnsure,
        resource_type: IntentResourceType.Volume,
        resource_id: volumeId,
        status: IntentStatus.Pending,
        target_generation: 1,
      }),
      row({
        id: updateId,
        kind: IntentKind.ContainerUpdate,
        resource_type: IntentResourceType.Container,
        resource_id: containerId,
        server_id: serverId,
        status: IntentStatus.Pending,
        blocked_by_intent_id: ensureId,
        target_generation: 2,
      }),
    ]);
    const repository = new IntentRepository(db as never, wake as never);
    const result = await repository.settleForObservedGeneration(
      IntentResourceType.Volume,
      volumeId,
      1,
      { outcome: 'succeeded', placementServerId: serverId },
    );
    expect(result).toEqual({ succeeded: 1, failed: 0, superseded: 0 });
    expect(wake.wake).toHaveBeenCalledWith({
      resourceType: IntentResourceType.Container,
      resourceId: containerId,
      serverId,
      reason: 'intent',
    });
  });

  it('ensurePending matches kind and idempotencyKey, not a sibling resize', async () => {
    const { db, store } = makeExecutor([
      row({
        id: olderId,
        kind: IntentKind.VolumeResize,
        request_json: { operation: 'resize', idempotencyKey: 'resize' },
        status: IntentStatus.Pending,
      }),
    ]);
    const repository = new IntentRepository(db as never);
    const created = await repository.ensurePending({
      kind: IntentKind.VolumeEnsure,
      resourceType: IntentResourceType.Volume,
      resourceId: volumeId,
      serverId,
      targetGeneration: 1,
      reuseSettled: false,
      request: { operation: 'ensure_attachment', idempotencyKey: 'ensure_attachment' },
    }, db as never);
    expect(created.id).not.toBe(olderId);
    expect(store.intents).toHaveLength(2);
    const reused = await repository.ensurePending({
      kind: IntentKind.VolumeEnsure,
      resourceType: IntentResourceType.Volume,
      resourceId: volumeId,
      serverId,
      targetGeneration: 1,
      reuseSettled: false,
      request: { operation: 'ensure_attachment', idempotencyKey: 'ensure_attachment' },
    }, db as never);
    expect(reused.id).toBe(created.id);
  });

  it('reuses a failed scan intent when reuseFailed is set', async () => {
    const { db, store } = makeExecutor([
      row({
        id: olderId,
        kind: IntentKind.ImageAssignmentEnsure,
        resource_type: IntentResourceType.ImageAssignment,
        resource_id: volumeId,
        request_json: { source: 'full_scan', idempotencyKey: 'image-scan:missing' },
        status: IntentStatus.Failed,
      }),
    ]);
    const repository = new IntentRepository(db as never);
    const reused = await repository.ensurePending({
      kind: IntentKind.ImageAssignmentEnsure,
      resourceType: IntentResourceType.ImageAssignment,
      resourceId: volumeId,
      serverId,
      targetGeneration: 1,
      reuseFailed: true,
      request: { source: 'full_scan', idempotencyKey: 'image-scan:missing' },
    }, db as never);
    expect(reused.id).toBe(olderId);
    expect(store.intents).toHaveLength(1);
  });

  it('returns an empty page without querying when resourceIds is empty', async () => {
    const { db } = makeExecutor([]);
    const selectFrom = vi.fn(db.selectFrom);
    db.selectFrom = selectFrom;
    const repository = new IntentRepository(db as never);
    await expect(repository.list({ resourceIds: [] })).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    await expect(repository.listPending({ resourceIds: [] })).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    expect(selectFrom).not.toHaveBeenCalled();
  });

  it('filters list and listPending by a non-empty resourceIds IN list', async () => {
    const otherId = '99999999-9999-4999-8999-999999999999';
    const { db } = makeExecutor([
      row({ id: olderId, resource_id: volumeId }),
      row({ id: newerId, resource_id: otherId, created_at: new Date('2026-01-01T00:00:03.000Z') }),
    ]);
    const selectFrom = vi.fn(db.selectFrom);
    db.selectFrom = selectFrom;
    const repository = new IntentRepository(db as never);
    const history = await repository.list({ resourceIds: [volumeId] });
    expect(history.items.map((item) => item.id)).toEqual([olderId]);
    const pending = await repository.listPending({ resourceIds: [volumeId] });
    expect(pending.items.map((item) => item.id)).toEqual([olderId]);
    expect(selectFrom).toHaveBeenCalled();
  });
});
