import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  AgentTaskKind,
  MAX_SYNCHRONOUS_QUOTA_INTENTS_PER_MUTATION,
  UserStatus,
} from '@nyabase/common';
import { v4 as uuidv4 } from 'uuid';
import { WorkflowEnqueuePort } from '../agent-tasks/workflow-enqueue.port.js';
import { ResourceKeyService } from '../agent-tasks/resource-key.service.js';
import { sql, type Transaction } from 'kysely';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { StorageRepository } from '../storage/storage.repository.js';

export interface QuotaApplyRequest {
  serverId: string;
  userId: string;
  numericUserId: number;
  diskBytes: number;
  requestedBy: string | null;
  /** Reserved for the user-deletion drain; public grant paths must omit it. */
  allowDeleting?: boolean;
}

@Injectable()
export class QuotaDispatchService {
  constructor(
    private readonly transactions: PgTransactionManager,
    private readonly storage: StorageRepository,
    private readonly workflow: WorkflowEnqueuePort,
    private readonly resourceKeys: ResourceKeyService,
  ) {}

  async apply(request: QuotaApplyRequest): Promise<string> {
    return this.transactions.run((transaction) =>
      this.applyInTransaction(transaction, request));
  }

  async applyInTransaction(
    transaction: Transaction<NyabaseDatabase>,
    request: QuotaApplyRequest,
  ): Promise<string> {
    return (await this.applyManyInTransaction(transaction, [request]))[0]!;
  }

  async applyManyInTransaction(
    transaction: Transaction<NyabaseDatabase>,
    requests: readonly QuotaApplyRequest[],
  ): Promise<string[]> {
    if (requests.length === 0) return [];
    if (requests.length > MAX_SYNCHRONOUS_QUOTA_INTENTS_PER_MUTATION) {
      throw new ConflictException({
        code: 'QUOTA_FANOUT_LIMIT',
        message:
          `At most ${MAX_SYNCHRONOUS_QUOTA_INTENTS_PER_MUTATION} quota mutations `
          + 'are supported per transaction',
        requestedIntents: requests.length,
        maxIntents: MAX_SYNCHRONOUS_QUOTA_INTENTS_PER_MUTATION,
      });
    }
    const requestKeys = requests.map((request) =>
      `${request.serverId}\0${request.userId}`);
    if (new Set(requestKeys).size !== requestKeys.length) {
      throw new ConflictException({
        code: 'DUPLICATE_QUOTA_MUTATION',
        message: 'A quota transaction may mutate each server/user pair only once',
      });
    }
    const uniqueKeys = requestKeys.map((key) =>
      `quota:${key.replace('\0', ':')}`).sort();
    await sql`
      SELECT pg_advisory_xact_lock(
        1856214886,
        hashtext(lock_key)
      )
      FROM unnest(${sql.val(uniqueKeys)}::text[]) AS locks(lock_key)
      ORDER BY lock_key
    `.execute(transaction);
    const serverIds = [...new Set(requests.map((request) => request.serverId))];
    const userIds = [...new Set(requests.map((request) => request.userId))];
    const [servers, users] = await Promise.all([
      transaction.selectFrom('infra.servers')
        .select('id')
        .where('id', 'in', serverIds)
        .execute(),
      transaction.selectFrom('iam.users')
        .select(['id', 'status', 'numeric_id'])
        .where('id', 'in', userIds)
        .execute(),
    ]);
    const knownServers = new Set(servers.map((server) => server.id));
    const usersById = new Map(users.map((user) => [user.id, user]));
    for (const request of requests) {
      if (!knownServers.has(request.serverId)) {
        throw new NotFoundException('Server not found');
      }
      const user = usersById.get(request.userId);
      if (!user) throw new NotFoundException('User not found');
      if (user.status === UserStatus.Deleted) {
        throw new ConflictException({
          code: 'USER_DELETED',
          message: 'A deleted user cannot receive quota intent',
          userId: request.userId,
        });
      }
      if (
        user.status === UserStatus.Deleting
        && (request.allowDeleting !== true || request.diskBytes !== 0)
      ) {
        throw new ConflictException({
          code: 'USER_DELETING',
          message: 'A deleting user accepts only its internal quota drain intent',
          userId: request.userId,
        });
      }
      if (user.numeric_id !== request.numericUserId) {
        throw new ConflictException(`User ${request.userId} numeric quota identity changed`);
      }
    }
    const taskIds: string[] = [];
    for (const request of requests) {
      taskIds.push(await this.applyPreparedInTransaction(transaction, request));
    }
    return taskIds;
  }

  private async applyPreparedInTransaction(
    transaction: Transaction<NyabaseDatabase>,
    request: QuotaApplyRequest,
  ): Promise<string> {
    const resourceKey = this.resourceKeys.quota(request.serverId, request.userId);
    await this.workflow.supersedePendingForResourceInTransaction(transaction, {
      serverId: request.serverId,
      resourceType: 'quota',
      resourceId: request.userId,
      reason: 'A newer durable quota generation replaced this undispatched task',
    });

    // A sent/staged quota task or a container task may still own this shared
    // user quota. Never commit a new grant intent while an older physical
    // effect can still finish; the caller's business transaction must retry.
    const held = (await this.workflow.findResourceClaims(transaction, [resourceKey]))[0];
    if (held) {
      throw new ConflictException({
        code: 'QUOTA_MUTATION_IN_PROGRESS',
        message: `Quota for user ${request.userId} is being reconciled by task ${held.taskId}`,
        taskKind: (await transaction.selectFrom('workflow.tasks')
          .select('kind')
          .where('id', '=', held.taskId)
          .executeTakeFirst())?.kind ?? null,
      });
    }

    const existing = await this.storage.findQuotaDesired(
      request.serverId,
      request.userId,
      transaction,
    );
    const generation = (existing?.generation ?? 0) + 1;
    const desiredId = existing?.id ?? uuidv4();
    const task = await this.workflow.enqueueInTransaction(transaction, {
      kind: AgentTaskKind.QuotaEnsure,
      serverId: request.serverId,
      resourceType: 'quota',
      resourceId: request.userId,
      requestedBy: request.requestedBy,
      payload: {
        generation,
        numericUserId: request.numericUserId,
        diskBytes: request.diskBytes,
      },
      request: {
        source: 'grant',
        generation,
        numericUserId: request.numericUserId,
        diskBytes: request.diskBytes,
      },
      resourceKeys: [resourceKey],
      beforeCommit: async (taskTransaction, context) => {
        const desired = await this.storage.upsertQuotaDesired({
          id: desiredId,
          serverId: request.serverId,
          userId: request.userId,
          numericUserId: request.numericUserId,
          limitBytes: request.diskBytes,
          generation,
          lastTaskId: context.taskId,
        }, existing?.generation ?? null, taskTransaction);
        if (!desired) {
          throw new ConflictException(
            'Quota desired state changed while preparing the Agent task; retry',
          );
        }
      },
    });
    return task.taskId;
  }
}
