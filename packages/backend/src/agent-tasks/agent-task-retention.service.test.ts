import {
  AgentTaskKind,
  AgentTaskStatus,
  MAX_AGENT_TASK_RESULT_BYTES,
  ServerStatus,
  canonicalJson,
} from '@nyabase/common';
import { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DB_ENTITIES } from '../database/db-entities.js';
import { AgentTaskEntity } from '../entities/agent-task.entity.js';
import { ImageEntity } from '../entities/image.entity.js';
import { QuotaDesiredEntity } from '../entities/quota-desired.entity.js';
import { ResourceLockEntity } from '../entities/resource-lock.entity.js';
import { ServerEntity } from '../entities/server.entity.js';
import {
  AGENT_TASK_MIN_RETENTION_MS,
  AgentTaskRetentionService,
} from './agent-task-retention.service.js';
import { MAX_AGENT_TASK_WIRE_BYTES } from './agent-tasks.service.js';

const NOW = new Date('2026-07-16T00:00:00.000Z');
const OLD = new Date(NOW.getTime() - AGENT_TASK_MIN_RETENTION_MS - 1);
const RECENT = new Date(NOW.getTime() - AGENT_TASK_MIN_RETENTION_MS + 1);

describe('AgentTaskRetentionService', () => {
  let dataSource: DataSource;
  let service: AgentTaskRetentionService;
  let queries: string[];

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
      entities: DB_ENTITIES,
    });
    await dataSource.initialize();
    await dataSource.getRepository(ServerEntity).save([
      server('server-a', ServerStatus.Online),
      server('server-quarantined', ServerStatus.AgentQuarantined),
    ]);
    service = new AgentTaskRetentionService(dataSource);
  });

  afterEach(async () => {
    service.onModuleDestroy();
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  it('prunes only expired unreferenced history and preserves every recovery authority', async () => {
    const tasks = dataSource.getRepository(AgentTaskEntity);
    await tasks.save([
      task('task-delete', 'server-a', OLD),
      task('task-recent', 'server-a', RECENT),
      task('task-locked', 'server-a', OLD, AgentTaskStatus.Failed),
      task('task-quota-proof', 'server-a', OLD),
      task('task-image-current', 'server-a', OLD, AgentTaskStatus.Succeeded, {
        kind: AgentTaskKind.ImageEnsureAbsent,
        resourceType: 'image',
        resourceId: 'image-a',
        requestJson: { cleanupGeneration: 2 },
      }),
      task('task-image-old', 'server-a', OLD, AgentTaskStatus.Succeeded, {
        kind: AgentTaskKind.ImageEnsureAbsent,
        resourceType: 'image',
        resourceId: 'image-a',
        requestJson: { cleanupGeneration: 1 },
      }),
      task('task-image-malformed', 'server-a', OLD, AgentTaskStatus.Succeeded, {
        kind: AgentTaskKind.ImageEnsureAbsent,
        resourceType: 'image',
        resourceId: 'image-a',
        requestJson: { cleanupGeneration: 'not-an-integer' },
      }),
      task('task-quarantined', 'server-quarantined', OLD),
    ]);
    await dataSource.getRepository(ResourceLockEntity).save({
      resourceKey: 'image:server-a:locked',
      taskId: 'task-locked',
      serverId: 'server-a',
    });
    await dataSource.getRepository(QuotaDesiredEntity).save({
      id: 'quota-a',
      serverId: 'server-a',
      userId: 'user-a',
      numericUserId: 1001,
      limitBytes: 1024,
      source: 'grant',
      generation: 1,
      lastTaskId: 'task-quota-proof',
    });
    await dataSource.getRepository(ImageEntity).save({
      id: 'image-a',
      name: 'Image A',
      dockerImage: 'example.invalid/image:a',
      runtimeOverrides: { uid: 0, entrypoint: null, cmd: null, init: false },
      description: null,
      isActive: false,
      disableSsh: false,
      deleting: true,
      cleanupGeneration: 2,
    });

    await expect(service.process(NOW)).resolves.toEqual({ scanned: 7, deleted: 3 });

    const remaining = (await tasks.find({ order: { id: 'ASC' } })).map((row) => row.id);
    expect(remaining).toEqual([
      'task-image-current',
      'task-image-malformed',
      'task-locked',
      'task-quota-proof',
      'task-recent',
    ]);
  });

  it('does not read maximum-size payload or result columns while pruning history', async () => {
    const taskId = 'task-large-history';
    const payloadJson = {
      dockerRef: `example.invalid/${'p'.repeat(MAX_AGENT_TASK_WIRE_BYTES - 512)}`,
    };
    const resultJson = {
      imageId: null,
      dockerId: 'sha256:large',
      dockerRef: 'example.invalid/large:latest',
      diagnostic: 'r'.repeat(MAX_AGENT_TASK_RESULT_BYTES - 1_024),
    };
    expect(Buffer.byteLength(canonicalJson({
      kind: AgentTaskKind.ImageEnsurePresent,
      payload: payloadJson,
    }))).toBeLessThanOrEqual(MAX_AGENT_TASK_WIRE_BYTES);
    expect(Buffer.byteLength(canonicalJson({
      taskId,
      payloadHash: 'a'.repeat(64),
      status: 'succeeded',
      result: resultJson,
    }))).toBeLessThanOrEqual(MAX_AGENT_TASK_RESULT_BYTES);

    await dataSource.getRepository(AgentTaskEntity).save(task(taskId, 'server-a', OLD, undefined, {
      payloadJson,
      agentResultJson: { status: 'succeeded', result: resultJson },
      resultJson,
    }));
    queries.length = 0;

    await expect(service.process(NOW)).resolves.toEqual({ scanned: 1, deleted: 1 });

    const candidateQuery = queries.find((query) =>
      query.includes('FROM "agent_tasks" "task"')
      && query.includes('"task"."completed_at" <= ?'));
    expect(candidateQuery).toBeDefined();
    expect(candidateQuery).toContain("json_extract(\"task\".\"request_json\", '$.cleanupGeneration')");
    expect(candidateQuery).not.toContain('"task"."request_json" AS');
    expect(candidateQuery).not.toContain('"task"."payload_json"');
    expect(candidateQuery).not.toContain('"task"."agent_result_json"');
    expect(candidateQuery).not.toContain('"task"."result_json"');
    expect(candidateQuery).not.toContain('"task"."error_json"');
    expect(await dataSource.getRepository(AgentTaskEntity).countBy({ id: taskId })).toBe(0);
  });
});

function server(id: string, status: ServerStatus): Partial<ServerEntity> {
  return {
    id,
    name: id,
    slug: id,
    agentTokenHash: `token-${id}`,
    hostFingerprint: null,
    agentConfigFingerprint: null,
    status,
    lastSeenAt: null,
  };
}

function task(
  id: string,
  serverId: string,
  completedAt: Date,
  status = AgentTaskStatus.Succeeded,
  override: Partial<AgentTaskEntity> = {},
): Partial<AgentTaskEntity> {
  return {
    id,
    kind: AgentTaskKind.ImageEnsurePresent,
    serverId,
    resourceType: 'image',
    resourceId: id,
    requestedBy: null,
    requestJson: null,
    payloadJson: { dockerRef: `example.invalid/${id}` },
    payloadHash: 'a'.repeat(64),
    admissionClass: 'normal',
    status,
    failureStage: status === AgentTaskStatus.Failed ? 'agent' : null,
    agentResultJson: status === AgentTaskStatus.Succeeded
      ? { status: 'succeeded', result: null }
      : { status: 'failed', error: { code: 'FAILED', message: 'failed' } },
    dispatchAttemptCount: 1,
    incompleteResultCount: 0,
    retryWindowStartedAt: null,
    nextDispatchAt: null,
    finalizerAttemptCount: 0,
    finalizerRetryAt: null,
    resultJson: status === AgentTaskStatus.Succeeded ? null : null,
    errorJson: status === AgentTaskStatus.Failed ? { code: 'FAILED', message: 'failed' } : null,
    createdAt: completedAt,
    startedAt: completedAt,
    lastSentAt: completedAt,
    completedAt,
    ...override,
  };
}
