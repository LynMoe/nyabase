import {
  AgentTaskKind,
  AgentTaskStatus,
  Capability,
  MAX_AGENT_TASK_RESULT_BYTES,
  ServerStatus,
} from '@nyabase/common';
import { NotFoundException } from '@nestjs/common';
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

    await expect(service.listForAdmin(allEvidenceCapabilities)).resolves.toEqual([
      expect.objectContaining({
        id: 'task-large',
        request: null,
        agentResult: null,
        result: null,
        error: errorJson,
        payloadHash: 'a'.repeat(64),
        dispatchAttemptCount: 1,
      }),
    ]);

    const listQuery = queries.find(
      (query) =>
        query.includes('FROM "agent_tasks" "task"') &&
        query.includes('ORDER BY "task"."created_at" DESC'),
    );
    expect(listQuery).toBeDefined();
    const selectClause = listQuery!.split(' FROM ')[0]!;
    expect(selectClause).not.toContain('"task"."request_json"');
    expect(selectClause).not.toContain('"task"."payload_json"');
    expect(selectClause).not.toContain('"task"."agent_result_json"');
    expect(selectClause).not.toContain('"task"."result_json"');
    expect(selectClause).toContain('"task"."error_json"');
    expect(selectClause).toContain('"task"."payload_hash"');
    expect(selectClause).toContain('"task"."dispatch_attempt_count"');

    const detail = await service.getForAdmin('task-large', allEvidenceCapabilities);
    expect(detail.request).toEqual(requestJson);
    expect(detail.agentResult).toEqual(agentResultJson);
    expect(detail.result).toEqual(resultJson);
    expect(detail.payloadHash).toBe('a'.repeat(64));
    expect(detail.dispatchAttemptCount).toBe(1);

    const userDetail = await service.getForUser('user-a', 'task-large');
    expect(userDetail).toMatchObject({
      id: 'task-large',
      error: {
        code: 'TASK_FINALIZATION_FAILED',
        message: 'The server completed the task, but control-plane finalization failed',
      },
    });
    for (const field of [
      'requestedBy', 'request', 'agentResult', 'result', 'payloadHash', 'dispatchAttemptCount',
    ]) {
      expect(userDetail).not.toHaveProperty(field);
    }
    expect(JSON.stringify(userDetail)).not.toContain(requestJson.diagnostic);
    expect(JSON.stringify(userDetail)).not.toContain(resultJson.diagnostic);
    expect(JSON.stringify(userDetail)).not.toContain('VISIBLE_SUMMARY_ERROR');

    const userList = await service.listForUser('user-a');
    expect(userList).toEqual([userDetail]);
  });

  it('redacts RemoteFS plaintext and ciphertext from task detail DTOs', async () => {
    const encrypted = 'rfs-v1.iv.tag.ciphertext';
    const requestJson = {
      scope: 'assign',
      mountId: 'remote-a',
      mount: {
        id: 'remote-a',
        params: {
          type: 'cephfs',
          monHosts: '10.0.0.9:6789',
          clientName: 'nyabase',
          exportPath: '/',
          secret: encrypted,
        },
      },
    };
    const now = new Date('2026-07-16T00:00:00.000Z');
    await dataSource.getRepository(AgentTaskEntity).save({
      id: 'task-remote',
      kind: AgentTaskKind.RemoteFsEnsure,
      serverId: 'server-a',
      resourceType: 'remote_fs_mount',
      resourceId: 'remote-a',
      requestedBy: 'user-a',
      requestJson,
      payloadJson: { id: 'remote-a' },
      payloadHash: 'b'.repeat(64),
      admissionClass: 'normal',
      status: AgentTaskStatus.Pending,
      failureStage: null,
      agentResultJson: null,
      dispatchAttemptCount: 0,
      incompleteResultCount: 0,
      retryWindowStartedAt: null,
      nextDispatchAt: now,
      finalizerAttemptCount: 0,
      finalizerRetryAt: null,
      resultJson: null,
      errorJson: null,
      createdAt: now,
      startedAt: null,
      lastSentAt: null,
      completedAt: null,
    });

    const admin = await service.getForAdmin('task-remote', allEvidenceCapabilities);
    const user = await service.getForUser('user-a', 'task-remote');
    expect(admin.request).toEqual({
      scope: 'assign',
      mountId: 'remote-a',
      mount: {
        id: 'remote-a',
        params: {
          type: 'cephfs',
          monHosts: '10.0.0.9:6789',
          clientName: 'nyabase',
          exportPath: '/',
        },
      },
    });
    expect(JSON.stringify(admin)).not.toContain(encrypted);
    expect(JSON.stringify(user)).not.toContain(encrypted);
    expect((await dataSource.getRepository(AgentTaskEntity).findOneByOrFail({ id: 'task-remote' })).requestJson)
      .toEqual(requestJson);
  });

  it('filters a mixed task ledger by exact capability domain and fails closed on mismatched rows', async () => {
    const now = new Date('2026-07-16T00:00:00.000Z');
    const saveTask = async (
      id: string,
      kind: AgentTaskKind,
      resourceType: string,
      resourceId: string,
    ) => dataSource.getRepository(AgentTaskEntity).save({
      id,
      kind,
      serverId: 'server-a',
      resourceType,
      resourceId,
      requestedBy: 'actor-a',
      requestJson: { secretEvidence: id },
      payloadJson: { id: resourceId },
      payloadHash: id.padEnd(64, 'a').slice(0, 64),
      admissionClass: 'normal',
      status: AgentTaskStatus.Pending,
      failureStage: null,
      agentResultJson: null,
      dispatchAttemptCount: 0,
      incompleteResultCount: 0,
      retryWindowStartedAt: null,
      nextDispatchAt: now,
      finalizerAttemptCount: 0,
      finalizerRetryAt: null,
      resultJson: null,
      errorJson: null,
      createdAt: now,
      startedAt: null,
      lastSentAt: null,
      completedAt: null,
    });
    await saveTask('task-container', AgentTaskKind.ContainerStart, 'container', 'container-a');
    await saveTask('task-image', AgentTaskKind.ImageEnsurePresent, 'image', 'image-a');
    await saveTask('task-remote', AgentTaskKind.RemoteFsEnsure, 'remote_fs_mount', 'remote-a');
    await saveTask('task-quota', AgentTaskKind.QuotaEnsure, 'quota', 'user-a');
    await saveTask(
      'task-mismatched',
      AgentTaskKind.ImageEnsurePresent,
      'container',
      'container-corrupt',
    );

    await expect(service.listForAdmin(new Set([Capability.ManageContainersAny])))
      .resolves.toEqual([expect.objectContaining({ id: 'task-container' })]);
    await expect(service.listForAdmin(new Set([Capability.ManageImages])))
      .resolves.toEqual([expect.objectContaining({ id: 'task-image' })]);
    await expect(service.listForAdmin(new Set([Capability.ManageServers])))
      .resolves.toEqual([expect.objectContaining({ id: 'task-remote' })]);
    await expect(service.listForAdmin(new Set([Capability.ManageGrants])))
      .resolves.toEqual([expect.objectContaining({ id: 'task-quota' })]);
    await expect(service.listForAdmin(new Set([
      Capability.ManageContainersAny,
      Capability.ManageImages,
    ]))).resolves.toEqual([
      expect.objectContaining({ id: 'task-image' }),
      expect.objectContaining({ id: 'task-container' }),
    ]);

    await expect(service.getForAdmin(
      'task-image',
      new Set([Capability.ManageContainersAny]),
    )).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getForAdmin(
      'task-mismatched',
      allEvidenceCapabilities,
    )).rejects.toBeInstanceOf(NotFoundException);
  });
});

const allEvidenceCapabilities = new Set([
  Capability.ManageContainersAny,
  Capability.ManageServers,
  Capability.ManageImages,
  Capability.ManageGrants,
]);
