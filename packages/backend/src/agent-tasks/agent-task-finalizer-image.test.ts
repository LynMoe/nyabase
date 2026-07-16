import { AgentTaskKind, AgentTaskStatus, ServerStatus } from '@nyabase/common';
import { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTaskEntity } from '../entities/agent-task.entity.js';
import { ImageEntity } from '../entities/image.entity.js';
import { ServerEntity } from '../entities/server.entity.js';
import { AgentTaskFinalizerService } from './agent-task-finalizer.service.js';

describe('AgentTaskFinalizerService image deletion fence', () => {
  let dataSource: DataSource;
  let queries: string[];
  let finalizer: AgentTaskFinalizerService;

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
      entities: [ServerEntity, AgentTaskEntity, ImageEntity],
    });
    await dataSource.initialize();
    await dataSource.getRepository(ServerEntity).save([
      server('server-a'),
      server('server-b'),
      server('server-c'),
      server('server-d'),
    ]);
    finalizer = new AgentTaskFinalizerService();
  });

  afterEach(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  it('uses scalar generation evidence and waits for every current-generation Server task', async () => {
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
    const current = task('task-current', 'server-a', AgentTaskStatus.Pending, {
      action: 'delete_image',
      dockerRef: 'example.invalid/image:a',
      cleanupGeneration: 2,
    });
    const blocker = task('task-blocker', 'server-b', AgentTaskStatus.Failed, {
      action: 'delete_image',
      dockerRef: 'example.invalid/image:a',
      cleanupGeneration: 2,
    });
    const oldGeneration = task('task-old', 'server-c', AgentTaskStatus.Failed, {
      action: 'delete_image',
      dockerRef: 'example.invalid/image:a',
      cleanupGeneration: 1,
    });
    const malformedGeneration = task('task-malformed', 'server-d', AgentTaskStatus.Failed, {
      action: 'delete_image',
      dockerRef: 'example.invalid/image:a',
      cleanupGeneration: 'corrupt',
    });
    // These columns are deliberately large. The existence query must inspect
    // only status and the request-generation scalar, not decode task bodies.
    blocker.payloadJson = { diagnostic: 'p'.repeat(512 * 1024) };
    blocker.resultJson = { diagnostic: 'r'.repeat(128 * 1024) };
    await dataSource.getRepository(AgentTaskEntity).save([
      current,
      blocker,
      oldGeneration,
      malformedGeneration,
    ]);

    queries.length = 0;
    await finalizer.applySucceeded(dataSource.manager, current, {
      imageId: 'image-a',
      dockerId: null,
      dockerRef: 'example.invalid/image:a',
      present: false,
    });
    expect(await dataSource.getRepository(ImageEntity).countBy({ id: 'image-a' })).toBe(1);

    const existenceQuery = queries.find((query) =>
      query.includes('FROM "agent_tasks" "candidate"')
      && query.includes("json_extract(\"candidate\".\"request_json\", '$.cleanupGeneration')"));
    expect(existenceQuery).toBeDefined();
    const selectClause = existenceQuery!.split(' FROM ')[0]!;
    expect(selectClause).not.toContain('request_json');
    expect(selectClause).not.toContain('payload_json');
    expect(selectClause).not.toContain('agent_result_json');
    expect(selectClause).not.toContain('result_json');
    expect(selectClause).not.toContain('error_json');

    await dataSource.getRepository(AgentTaskEntity).update(blocker.id, {
      status: AgentTaskStatus.Succeeded,
    });
    await finalizer.applySucceeded(dataSource.manager, current, {
      present: false,
    });
    // Malformed current ownership is fail-closed; it cannot be assumed old.
    expect(await dataSource.getRepository(ImageEntity).countBy({ id: 'image-a' })).toBe(1);

    await dataSource.getRepository(AgentTaskEntity).update(malformedGeneration.id, {
      status: AgentTaskStatus.Succeeded,
    });
    await finalizer.applySucceeded(dataSource.manager, current, {
      present: false,
    });
    // The valid old-generation failure is unrelated to the active deletion.
    expect(await dataSource.getRepository(ImageEntity).countBy({ id: 'image-a' })).toBe(0);
  });
});

function server(id: string): Partial<ServerEntity> {
  return {
    id,
    name: id,
    slug: id,
    agentTokenHash: `token-${id}`,
    hostFingerprint: null,
    agentConfigFingerprint: null,
    status: ServerStatus.Online,
    lastSeenAt: null,
  };
}

function task(
  id: string,
  serverId: string,
  status: AgentTaskStatus,
  requestJson: unknown,
): AgentTaskEntity {
  const now = new Date('2026-07-16T00:00:00.000Z');
  return {
    id,
    kind: AgentTaskKind.ImageEnsureAbsent,
    serverId,
    resourceType: 'image',
    resourceId: 'image-a',
    requestedBy: null,
    requestJson,
    payloadJson: { dockerRef: 'example.invalid/image:a', imageId: 'image-a' },
    payloadHash: 'a'.repeat(64),
    admissionClass: 'normal',
    status,
    failureStage: status === AgentTaskStatus.Failed ? 'agent' : null,
    agentResultJson: status === AgentTaskStatus.Pending ? null : { status: 'failed' },
    dispatchAttemptCount: 1,
    incompleteResultCount: 0,
    retryWindowStartedAt: null,
    nextDispatchAt: null,
    finalizerAttemptCount: 0,
    finalizerRetryAt: null,
    resultJson: null,
    errorJson: status === AgentTaskStatus.Failed ? { code: 'FAILED', message: 'failed' } : null,
    createdAt: now,
    startedAt: now,
    lastSentAt: now,
    completedAt: status === AgentTaskStatus.Pending ? null : now,
  } as AgentTaskEntity;
}
