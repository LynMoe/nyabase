import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  FailureCode,
  StoragePoolDriver,
  type SharedBackendExecutorDiscoverResult,
  type SharedBackendExecutorDto,
  type StorageDiscoverIssueDto,
} from '@nyabase/common';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { StoragePoolDiscoveryService, toDiscoverIssue } from './storage-pool-discovery.service.js';
import { toExecutorDto } from './storage-pool-dtos.js';
import { StoragePoolsRepository } from './storage-pools.repository.js';

/** The CephFS pools (one per server) through which servers reach a shared backend. */
@Injectable()
export class SharedBackendExecutorsService {
  private readonly logger = new Logger(SharedBackendExecutorsService.name);

  constructor(
    private readonly repository: StoragePoolsRepository,
    private readonly transactions: PgTransactionManager,
    private readonly discovery: StoragePoolDiscoveryService,
  ) {}

  async listExecutors(backendId: string): Promise<SharedBackendExecutorDto[]> {
    if (!await this.repository.sharedBackendExists(backendId)) {
      throw new NotFoundException('Shared backend not found');
    }
    const mapped = await this.listExecutorsByBackendIds([backendId]);
    return mapped.get(backendId) ?? [];
  }

  async listExecutorsByBackendIds(
    backendIds: readonly string[],
  ): Promise<Map<string, SharedBackendExecutorDto[]>> {
    const result = new Map<string, SharedBackendExecutorDto[]>();
    for (const id of backendIds) result.set(id, []);
    const rows = await this.repository.listExecutorsByBackendIds(backendIds);
    for (const row of rows) {
      if (row.shared_backend_id === null) continue;
      const list = result.get(row.shared_backend_id) ?? [];
      list.push(toExecutorDto(row));
      result.set(row.shared_backend_id, list);
    }
    return result;
  }

  /** Rediscover pools on one server (or every online server) and report identity conflicts. */
  async discoverExecutors(
    backendId: string,
    serverId?: string,
  ): Promise<SharedBackendExecutorDiscoverResult> {
    if (!await this.repository.sharedBackendExists(backendId)) {
      throw new NotFoundException('Shared backend not found');
    }
    let serverIds: string[];
    if (serverId) {
      if (!await this.repository.serverExists(serverId)) {
        throw new NotFoundException('Server not found');
      }
      serverIds = [serverId];
    } else {
      serverIds = await this.repository.listOnlineServerIds();
    }
    const identityConflicts: StorageDiscoverIssueDto[] = [];
    for (const id of serverIds) {
      try {
        const mapped = await this.discovery.discoverAndApply(id);
        identityConflicts.push(...mapped.identityConflicts);
      } catch (error) {
        if (error instanceof ConflictException || error instanceof BadRequestException) {
          throw error;
        }
        identityConflicts.push(toDiscoverIssue({
          code: FailureCode.ServerUnreachable,
          message: 'Server Incus endpoint is unreachable',
          serverId: id,
        }));
        const klass = error instanceof Error ? error.constructor.name : 'Error';
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`SERVER_UNREACHABLE serverId=${id} ${klass}: ${message}`);
      }
    }
    return {
      executors: await this.listExecutors(backendId),
      identityConflicts,
    };
  }

  async patchExecutor(
    backendId: string,
    executorId: string,
    input: {
      expectedRevision: number;
      registered: boolean;
    },
  ): Promise<SharedBackendExecutorDto> {
    const updated = await this.transactions.run(
      async (transaction) => {
        const observed = await this.repository.findById(executorId, transaction);
        if (
          !observed
          || observed.shared_backend_id !== backendId
          || observed.shareable !== true
          || observed.driver !== StoragePoolDriver.CephFs
        ) {
          throw new NotFoundException('Storage pool not found');
        }
        await this.repository.lockCapacityScope(
          executorId,
          observed.server_id,
          [observed.shared_backend_id],
          transaction,
        );
        const current = await this.repository.findByIdForUpdate(executorId, transaction);
        if (
          !current
          || current.shared_backend_id !== backendId
          || current.shareable !== true
          || current.driver !== StoragePoolDriver.CephFs
        ) {
          throw new NotFoundException('Storage pool not found');
        }
        if (Number(current.revision) !== input.expectedRevision) {
          throw new ConflictException({ code: FailureCode.RevisionConflict });
        }
        if (input.registered !== current.registered && !input.registered) {
          if (await this.repository.hasDependencies(executorId, transaction)) {
            throw new ConflictException({
              code: FailureCode.StoragePoolInUse,
              message: 'Storage pool registration or backend mapping cannot change while referenced',
            });
          }
        }
        const row = await this.repository.patch(executorId, input.expectedRevision, {
          registered: input.registered,
          shareable: true,
        }, transaction);
        if (!row) throw new ConflictException({ code: FailureCode.RevisionConflict });
        if (row.shared_backend_id) {
          await this.repository.refreshSharedBackendCapacity(row.shared_backend_id, transaction);
        }
        return row;
      },
      { isolationLevel: 'serializable', maxAttempts: 5 },
    );
    const mapped = await this.listExecutorsByBackendIds([backendId]);
    const dto = (mapped.get(backendId) ?? []).find((item) => item.id === updated.id);
    if (!dto) throw new NotFoundException('Storage pool not found');
    return dto;
  }
}
