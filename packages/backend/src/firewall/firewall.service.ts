import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  AuditAction,
  FailureCode,
  FIREWALL_MAX_CIDRS_PER_SERVER,
  FIREWALL_MAX_RULES_PER_SERVER,
  FirewallProtocol,
  type CreateFirewallRuleRequest,
  type FirewallPortRange,
  type FirewallRuleDto,
  type FirewallServerStatusDto,
  type PatchFirewallRuleRequest,
} from '@nyabase/common';
import type { Transaction } from 'kysely';
import { AuditService } from '../iam/audit.service.js';
import { isoDate, numberValue } from '../platform/domain-utils.js';
import { lockFirewallPolicy } from '../platform/persistence-pg/advisory-locks.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { afterCommit } from '../platform/post-commit.js';
import { jsonArray } from './firewall-document.js';
import { FirewallSyncService } from './firewall-sync.service.js';
import {
  FirewallRepository,
  type FirewallRuleRow,
  type FirewallRuleValues,
} from './firewall.repository.js';

const AUDIT_TARGET_TYPE = 'firewall_rule';

function pgErrorCode(error: unknown): string | null {
  let current: unknown = error;
  const visited = new Set<unknown>();
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const record = current as { code?: unknown; cause?: unknown };
    if (typeof record.code === 'string' && /^[0-9A-Z]{5}$/.test(record.code)) return record.code;
    current = record.cause;
  }
  return null;
}

function ruleConflict(details: Record<string, unknown> = {}): ConflictException {
  return new ConflictException({
    code: FailureCode.FirewallRuleConflict,
    message: 'A firewall rule with this name or priority already exists',
    details,
  });
}

function unknownServers(): BadRequestException {
  return new BadRequestException({
    code: FailureCode.InvalidInput,
    message: 'One or more serverIds do not exist',
  });
}

/** Unique violations and a server deleted under us become API errors, not 500s. */
function translateWriteError(error: unknown): unknown {
  const code = pgErrorCode(error);
  if (code === '23505') return ruleConflict();
  if (code === '23503') return unknownServers();
  return error;
}

function auditDetails(values: FirewallRuleValues, serverIds: readonly string[]) {
  return {
    name: values.name,
    description: values.description,
    priority: values.priority,
    action: values.action,
    protocol: values.protocol,
    ports: values.ports,
    cidrs: values.cidrs,
    serverIds: [...serverIds].sort(),
  };
}

@Injectable()
export class FirewallService {
  constructor(
    private readonly repository: FirewallRepository,
    private readonly transactions: PgTransactionManager,
    private readonly audit: AuditService,
    private readonly sync: FirewallSyncService,
  ) {}

  async list(): Promise<FirewallRuleDto[]> {
    return (await this.repository.list()).map(toDto);
  }

  async get(id: string): Promise<FirewallRuleDto> {
    const row = await this.repository.findById(id);
    if (!row) throw new NotFoundException('Firewall rule not found');
    return toDto(row);
  }

  async status(): Promise<FirewallServerStatusDto[]> {
    return this.sync.statuses(await this.repository.listServers());
  }

  async create(actorId: string, input: CreateFirewallRuleRequest): Promise<FirewallRuleDto> {
    const id = randomUUID();
    const values: FirewallRuleValues = {
      name: input.name,
      description: input.description,
      priority: input.priority,
      action: input.action,
      protocol: input.protocol,
      ports: input.ports,
      cidrs: input.cidrs,
    };
    try {
      await this.transactions.run(async (transaction) => {
        await lockFirewallPolicy(transaction);
        await this.assertUnique(values, undefined, transaction);
        await this.assertServers(input.serverIds, transaction);
        await this.assertWithinLimits(values, input.serverIds, undefined, transaction);
        await this.repository.insert(id, values, transaction);
        await this.repository.replaceServers(id, input.serverIds, transaction);
        await this.audit.append(
          transaction,
          actorId,
          AuditAction.CreateFirewallRule,
          id,
          AUDIT_TARGET_TYPE,
          auditDetails(values, input.serverIds),
        );
        afterCommit(transaction, () => this.sync.rulesChanged(input.serverIds));
      });
    } catch (error) {
      throw translateWriteError(error);
    }
    return this.get(id);
  }

  async patch(actorId: string, id: string, input: PatchFirewallRuleRequest): Promise<FirewallRuleDto> {
    try {
      await this.transactions.run(async (transaction) => {
        await lockFirewallPolicy(transaction);
        const current = await this.repository.findByIdForUpdate(id, transaction);
        if (!current) throw new NotFoundException('Firewall rule not found');
        if (numberValue(current.revision) !== input.expectedRevision) {
          throw new ConflictException({ code: FailureCode.RevisionConflict });
        }
        const values: FirewallRuleValues = {
          name: input.name ?? current.name,
          description: input.description ?? current.description,
          priority: input.priority ?? current.priority,
          action: input.action ?? current.action,
          protocol: input.protocol ?? current.protocol,
          ports: input.ports ?? jsonArray<FirewallPortRange>(current.ports),
          cidrs: input.cidrs ?? jsonArray<string>(current.cidrs),
        };
        if (values.protocol === FirewallProtocol.All && values.ports.length > 0) {
          throw new BadRequestException({
            code: FailureCode.InvalidInput,
            message: 'ports require protocol tcp or udp',
            details: { path: 'ports' },
          });
        }
        const before = await this.repository.listServerIds(id, transaction);
        const after = input.serverIds ?? before;
        await this.assertUnique(values, id, transaction);
        await this.assertServers(after, transaction);
        await this.assertWithinLimits(values, after, id, transaction);
        if (!(await this.repository.update(id, input.expectedRevision, values, transaction))) {
          throw new ConflictException({ code: FailureCode.RevisionConflict });
        }
        if (input.serverIds !== undefined) await this.repository.replaceServers(id, after, transaction);
        await this.audit.append(
          transaction,
          actorId,
          AuditAction.UpdateFirewallRule,
          id,
          AUDIT_TARGET_TYPE,
          {
            ...auditDetails(values, after),
            changed: Object.keys(input).filter((key) => key !== 'expectedRevision').sort(),
            revision: input.expectedRevision + 1,
          },
        );
        afterCommit(transaction, () => this.sync.rulesChanged([...before, ...after]));
      });
    } catch (error) {
      throw translateWriteError(error);
    }
    return this.get(id);
  }

  async delete(actorId: string, id: string): Promise<void> {
    await this.transactions.run(async (transaction) => {
      await lockFirewallPolicy(transaction);
      const current = await this.repository.findByIdForUpdate(id, transaction);
      if (!current) throw new NotFoundException('Firewall rule not found');
      const serverIds = await this.repository.listServerIds(id, transaction);
      await this.repository.delete(id, transaction);
      await this.audit.append(
        transaction,
        actorId,
        AuditAction.DeleteFirewallRule,
        id,
        AUDIT_TARGET_TYPE,
        auditDetails({
          name: current.name,
          description: current.description,
          priority: current.priority,
          action: current.action,
          protocol: current.protocol,
          ports: jsonArray<FirewallPortRange>(current.ports),
          cidrs: jsonArray<string>(current.cidrs),
        }, serverIds),
      );
      afterCommit(transaction, () => this.sync.rulesChanged(serverIds));
    });
  }

  private async assertUnique(
    values: FirewallRuleValues,
    excludeId: string | undefined,
    transaction: Transaction<NyabaseDatabase>,
  ): Promise<void> {
    const conflict = await this.repository.findConflict(values.name, values.priority, excludeId, transaction);
    if (!conflict) return;
    throw ruleConflict({
      field: conflict.name === values.name ? 'name' : 'priority',
      conflictingRuleId: conflict.id,
    });
  }

  private async assertServers(serverIds: readonly string[], transaction: Transaction<NyabaseDatabase>): Promise<void> {
    const existing = await this.repository.lockExistingServers(serverIds, transaction);
    if (existing.length !== serverIds.length) throw unknownServers();
  }

  /** Every server the rule will apply to stays within the per-server limits with it. */
  private async assertWithinLimits(
    values: FirewallRuleValues,
    serverIds: readonly string[],
    ruleId: string | undefined,
    transaction: Transaction<NyabaseDatabase>,
  ): Promise<void> {
    const usage = new Map(
      (await this.repository.usageByServer(serverIds, ruleId, transaction))
        .map((row) => [row.server_id, row]),
    );
    for (const serverId of [...serverIds].sort()) {
      const rules = (usage.get(serverId)?.rules ?? 0) + 1;
      const cidrs = (usage.get(serverId)?.cidrs ?? 0) + values.cidrs.length;
      if (rules <= FIREWALL_MAX_RULES_PER_SERVER && cidrs <= FIREWALL_MAX_CIDRS_PER_SERVER) continue;
      throw new BadRequestException({
        code: FailureCode.FirewallTooLarge,
        message: rules > FIREWALL_MAX_RULES_PER_SERVER
          ? `A server can have at most ${FIREWALL_MAX_RULES_PER_SERVER} firewall rules`
          : `The firewall rules of a server can list at most ${FIREWALL_MAX_CIDRS_PER_SERVER} CIDRs`,
        details: {
          serverId,
          rules,
          cidrs,
          maxRules: FIREWALL_MAX_RULES_PER_SERVER,
          maxCidrs: FIREWALL_MAX_CIDRS_PER_SERVER,
        },
      });
    }
  }
}

function toDto(row: FirewallRuleRow): FirewallRuleDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    priority: row.priority,
    action: row.action,
    protocol: row.protocol,
    ports: jsonArray<FirewallPortRange>(row.ports),
    cidrs: jsonArray<string>(row.cidrs),
    serverIds: row.server_ids ?? [],
    revision: numberValue(row.revision),
    createdAt: isoDate(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: isoDate(row.updated_at) ?? new Date(0).toISOString(),
  };
}
