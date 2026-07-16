import {
  AgentTaskKind,
  AgentTaskStatus,
  MAX_AGENT_TASK_RESULT_BYTES,
  ServerStatus,
} from '@nyabase/common';
import { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTaskEntity } from '../entities/agent-task.entity.js';
import { ServerEntity } from '../entities/server.entity.js';
import {
  AgentTasksService,
  MAX_AGENT_TASK_REQUEST_BYTES,
  MAX_AGENT_TASK_WIRE_BYTES,
} from './agent-tasks.service.js';

describe('AgentTasksService history projection', () => {
  let dataSource: DataSource;
  let queries: string[];
  let service: AgentTasksService;

  beforeEach(async () => {
    queries = [];
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      logging: ['query'],
      logger: {
        logQuery: (query: string) => queries.push(query),
        logQueryError: vi.fn(),
        logQuerySlow: vi.fn(),
        logSchemaBuild: vi.fn(),
        logMigration: vi.fn(),
        log: vi.fn(),
      } as never,
      synchronize: true,
      entities: [ServerEntity, AgentTaskEntity],
    });
    await dataSource.initialize();
    await dataSource.getRepository(ServerEntity).save({
      id: 'server-a',
      name: 'Server A',
      slug: 'server-a',
      agentTokenHash: 'token-a',
      hostFingerprint: null,
      agentConfigFingerprint: null,
      status: ServerStatus.Online,
      lastSeenAt: null,
    });
    service = new AgentTasksService(
      dataSource,
      {} as never,
      {} as never,
      {} as never,
      dataSource.getRepository(AgentTaskEntity),
    );
  });

  afterEach(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  it('returns bounded summaries without selecting large task evidence columns', async () => {
    const requestJson = { diagnostic: 'q'.repeat(MAX_AGENT_TASK_REQUEST_BYTES - 512) };
    const payloadJson = { diagnostic: 'p'.repeat(MAX_AGENT_TASK_WIRE_BYTES - 512) };
    const agentResultJson = {
      status: 'succeeded',
      result: { diagnostic: 'a'.repeat(MAX_AGENT_TASK_RESULT_BYTES - 1_024) },
    };
    const resultJson = { diagnostic: 'r'.repeat(MAX_AGENT_TASK_RESULT_BYTES - 1_024) };
    const errorJson = { code: 'VISIBLE_SUMMARY_ERROR', message: 'bounded error' };
    const now = new Date('2026-07-16T00:00:00.000Z');
    await dataSource.getRepository(AgentTaskEntity).save({
      id: 'task-large',
      kind: AgentTaskKind.ImageEnsurePresent,
      serverId: 'server-a',
      resourceType: 'image',
      resourceId: 'image-a',
      requestedBy: 'user-a',
      requestJson,
      payloadJson,
      payloadHash: 'a'.repeat(64),
      admissionClass: 'normal',
      status: AgentTaskStatus.Failed,
      failureStage: 'finalizer',
      agentResultJson,
      dispatchAttemptCount: 1,
      incompleteResultCount: 0,
      retryWindowStartedAt: null,
      nextDispatchAt: null,
      finalizerAttemptCount: 1,
      finalizerRetryAt: null,
      resultJson,
      errorJson,
      createdAt: now,
      startedAt: now,
      lastSentAt: now,
      completedAt: now,
    });
    queries.length = 0;

    await expect(service.listForAdmin()).resolves.toEqual([
      expect.objectContaining({
        id: 'task-large',
        request: null,
        agentResult: null,
        result: null,
        error: errorJson,
      }),
    ]);

    const listQuery = queries.find((query) =>
      query.includes('FROM "agent_tasks" "task"')
      && query.includes('ORDER BY "task"."created_at" DESC'));
    expect(listQuery).toBeDefined();
    const selectClause = listQuery!.split(' FROM ')[0]!;
    expect(selectClause).not.toContain('"task"."request_json"');
    expect(selectClause).not.toContain('"task"."payload_json"');
    expect(selectClause).not.toContain('"task"."agent_result_json"');
    expect(selectClause).not.toContain('"task"."result_json"');
    expect(selectClause).toContain('"task"."error_json"');

    const detail = await service.getForAdmin('task-large');
    expect(detail.request).toEqual(requestJson);
    expect(detail.agentResult).toEqual(agentResultJson);
    expect(detail.result).toEqual(resultJson);
  });
});
