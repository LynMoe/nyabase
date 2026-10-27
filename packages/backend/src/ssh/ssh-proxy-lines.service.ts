import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Kysely, Transaction } from 'kysely';
import {
  AuditAction,
  FailureCode,
  MAX_SSH_PROXY_LINES,
  type CreateSshProxyLineRequest,
  type PatchSshProxyLineRequest,
  type ReorderSshProxyLinesRequest,
  type SshProxyLineDto,
} from '@nyabase/common';
import { AuditService } from '../iam/audit.service.js';
import { lockSshProxyLines } from '../platform/persistence-pg/advisory-locks.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';

const AUDIT_TARGET_TYPE = 'ssh_proxy';

type Executor = Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase>;

function nameConflict(): ConflictException {
  return new ConflictException({
    code: FailureCode.SshProxyLineConflict,
    message: 'An SSH proxy line with this name already exists',
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function lineNotFound(): NotFoundException {
  return new NotFoundException('SSH proxy line not found');
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505';
}

/**
 * The SSH proxy's public addresses ("lines"). Users see them in
 * `ssh-client-config`; only administrators change them. Lines carry no
 * routing state, so a write needs no snapshot broadcast.
 */
@Injectable()
export class SshProxyLinesService {
  constructor(
    @Inject(PG_DATABASE)
    private readonly database: Kysely<NyabaseDatabase>,
    private readonly transactions: PgTransactionManager,
    private readonly audit: AuditService,
  ) {}

  /** In the administrators' order. */
  async list(executor: Executor = this.database): Promise<SshProxyLineDto[]> {
    const rows = await executor
      .selectFrom('interaction.ssh_proxy_lines')
      .select(['id', 'name', 'host', 'port', 'hint'])
      .orderBy('sort_order')
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    return rows.map((row) => ({ id: row.id, name: row.name, host: row.host, port: row.port, hint: row.hint }));
  }

  async create(actorId: string, input: CreateSshProxyLineRequest): Promise<SshProxyLineDto> {
    const id = randomUUID();
    return this.write(async (transaction) => {
      const lines = await this.list(transaction);
      if (lines.length >= MAX_SSH_PROXY_LINES) {
        throw new BadRequestException({
          code: FailureCode.InvalidInput,
          message: `At most ${MAX_SSH_PROXY_LINES} SSH proxy lines`,
        });
      }
      await transaction
        .insertInto('interaction.ssh_proxy_lines')
        .values({ id, ...input, sort_order: lines.length })
        .execute();
      await this.audit.append(transaction, actorId, AuditAction.CreateSshProxyLine, id, AUDIT_TARGET_TYPE, input);
      return { id, ...input };
    });
  }

  async patch(actorId: string, id: string, input: PatchSshProxyLineRequest): Promise<SshProxyLineDto> {
    if (!UUID_RE.test(id)) throw lineNotFound();
    return this.write(async (transaction) => {
      const updated = await transaction
        .updateTable('interaction.ssh_proxy_lines')
        .set({ ...input, updated_at: new Date() })
        .where('id', '=', id)
        .returning(['id', 'name', 'host', 'port', 'hint'])
        .executeTakeFirst();
      if (!updated) throw lineNotFound();
      await this.audit.append(transaction, actorId, AuditAction.UpdateSshProxyLine, id, AUDIT_TARGET_TYPE, input);
      return updated;
    });
  }

  async delete(actorId: string, id: string): Promise<{ deleted: true }> {
    if (!UUID_RE.test(id)) throw lineNotFound();
    return this.write(async (transaction) => {
      const deleted = await transaction
        .deleteFrom('interaction.ssh_proxy_lines')
        .where('id', '=', id)
        .returning(['name', 'host', 'port'])
        .executeTakeFirst();
      if (!deleted) throw lineNotFound();
      await this.renumber(transaction, (await this.list(transaction)).map((line) => line.id));
      await this.audit.append(transaction, actorId, AuditAction.DeleteSshProxyLine, id, AUDIT_TARGET_TYPE, deleted);
      return { deleted: true as const };
    });
  }

  /** `ids` must name every line exactly once; a stale list (a line added or removed since) is a conflict. */
  async reorder(actorId: string, input: ReorderSshProxyLinesRequest): Promise<SshProxyLineDto[]> {
    return this.write(async (transaction) => {
      const current = (await this.list(transaction)).map((line) => line.id);
      const requested = new Set(input.ids);
      if (requested.size !== input.ids.length || current.length !== input.ids.length
        || current.some((id) => !requested.has(id))) {
        throw new ConflictException({
          code: FailureCode.RevisionConflict,
          message: 'The SSH proxy lines changed; reload and try again',
        });
      }
      await this.renumber(transaction, input.ids);
      await this.audit.append(
        transaction,
        actorId,
        AuditAction.ReorderSshProxyLines,
        'lines',
        AUDIT_TARGET_TYPE,
        { ids: input.ids },
      );
      return this.list(transaction);
    });
  }

  private async renumber(transaction: Transaction<NyabaseDatabase>, ids: readonly string[]): Promise<void> {
    for (const [index, id] of ids.entries()) {
      await transaction
        .updateTable('interaction.ssh_proxy_lines')
        .set({ sort_order: index })
        .where('id', '=', id)
        .execute();
    }
  }

  private async write<T>(work: (transaction: Transaction<NyabaseDatabase>) => Promise<T>): Promise<T> {
    try {
      return await this.transactions.run(async (transaction) => {
        await lockSshProxyLines(transaction);
        return work(transaction);
      });
    } catch (error) {
      throw isUniqueViolation(error) ? nameConflict() : error;
    }
  }
}
