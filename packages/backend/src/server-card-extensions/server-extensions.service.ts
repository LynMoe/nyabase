import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  forwardRef,
} from '@nestjs/common';
import {
  AuditAction,
  Capability,
  FailureCode,
  zPatchServerExtensionRequest,
  type ExtensionDevicesResponseDto,
  type ServerExtensionEnablementDto,
} from '@nyabase/common';
import type { Kysely, Transaction } from 'kysely';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { AccessResolverService } from '../access/access-resolver.service.js';
import { AuditService } from '../audit/audit.service.js';
import {
  INCUS_CLIENT_FACTORY,
  type IncusClientFactory,
} from '../runtime/reconcile-worker.service.js';
import {
  NODE_METRICS_PULL,
  type NodeMetricsPullPort,
} from '../runtime/server-preflight-reconciler.service.js';
import { ExtensionDeviceClaimsRepository } from './claims.repository.js';
import { asJsonObject } from './json.js';
import { ServerCardExtensionRegistry } from './registry.js';
import type { ExtensionActor, ExtensionGrantView } from './types.js';

function occupiedError(extensionId: string): ConflictException {
  return new ConflictException({
    code: FailureCode.ExtensionOccupied,
    message: 'The server extension still has device claims',
    details: { extensionId },
  });
}

function isOccupiedSqlError(error: unknown): boolean {
  let current: unknown = error;
  const visited = new Set<unknown>();
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const record = current as { code?: unknown; hint?: unknown; cause?: unknown };
    if (record.code === 'P0001' && String(record.hint ?? '') === FailureCode.ExtensionOccupied) {
      return true;
    }
    current = record.cause;
  }
  return false;
}

@Injectable()
export class ServerCardExtensionsService {
  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly transactions: PgTransactionManager,
    private readonly registry: ServerCardExtensionRegistry,
    private readonly claims: ExtensionDeviceClaimsRepository,
    private readonly access: AccessResolverService,
    private readonly audit: AuditService,
    @Optional() @Inject(forwardRef(() => INCUS_CLIENT_FACTORY)) private readonly clients?: IncusClientFactory,
    @Optional() @Inject(forwardRef(() => NODE_METRICS_PULL)) private readonly nodeMetrics?: NodeMetricsPullPort,
  ) {}

  requireRegistered(extensionId: string, path: boolean) {
    const ext = this.registry.get(extensionId);
    if (ext) return ext;
    if (path) {
      throw new NotFoundException({
        code: FailureCode.ExtensionUnknown,
        message: 'Unknown server-card extension',
        details: { extensionId },
      });
    }
    throw new BadRequestException({
      code: FailureCode.ExtensionUnknown,
      message: 'Unknown server-card extension',
      details: { extensionId },
    });
  }

  async listEnablement(serverId: string): Promise<ServerExtensionEnablementDto[]> {
    await this.requireServer(serverId);
    const rows = await this.database
      .selectFrom('infra.server_extensions')
      .select(['extension_id', 'enabled', 'health'])
      .where('server_id', '=', serverId)
      .execute();
    const byId = new Map(rows.map((row) => [row.extension_id, row]));
    const items: ServerExtensionEnablementDto[] = [];
    for (const ext of this.registry.all()) {
      const row = byId.get(ext.id);
      items.push({
        extensionId: ext.id,
        displayName: ext.displayName,
        enabled: row?.enabled === true,
        health: asJsonObject(row?.health),
        occupiedDeviceCount: await this.claims.countForServerExtension(ext.id, serverId),
      });
    }
    return items;
  }

  async putEnablement(
    actorId: string,
    serverId: string,
    extensionId: string,
    body: unknown,
  ): Promise<ServerExtensionEnablementDto> {
    const ext = this.requireRegistered(extensionId, true);
    const input = zPatchServerExtensionRequest.parse(body);
    await this.requireServer(serverId);
    if (input.enabled) {
      await this.transactions.run(async (transaction) => {
        await this.access.assertActorCapabilitiesInTransaction(transaction, actorId, [
          Capability.ManageServers,
        ]);
        await transaction
          .insertInto('infra.server_extensions')
          .values({
            server_id: serverId,
            extension_id: extensionId,
            enabled: true,
            health: {},
            enabled_by: actorId,
            enabled_at: new Date(),
          })
          .onConflict((conflict) => conflict
            .columns(['server_id', 'extension_id'])
            .doUpdateSet({
              enabled: true,
              enabled_by: actorId,
              enabled_at: new Date(),
            }))
          .execute();
        await this.audit.append(
          transaction,
          actorId,
          AuditAction.UpdateServerExtension,
          serverId,
          'server',
          { extensionId, enabled: true },
        );
      });
      const { resources, metricSamples } = await this.loadInventory(serverId);
      await ext.refreshHealth({
        health: this.claims.health(serverId, extensionId),
        serverId,
        resources,
        metricSamples,
      });
    } else {
      try {
        await this.transactions.run(async (transaction) => {
          await this.access.assertActorCapabilitiesInTransaction(transaction, actorId, [
            Capability.ManageServers,
          ]);
          const occupied = await this.claims.countForServerExtension(
            extensionId,
            serverId,
            transaction,
          );
          if (occupied > 0) throw occupiedError(extensionId);
          await ext.assertCanDisable({
            serverId,
            actor: { userId: actorId, admin: true },
            grant: { extensionGrants: null },
            claims: this.claims.forServer(extensionId, serverId, transaction),
            health: this.claims.health(serverId, extensionId, transaction),
          });
          const updated = await transaction
            .updateTable('infra.server_extensions')
            .set({ enabled: false })
            .where('server_id', '=', serverId)
            .where('extension_id', '=', extensionId)
            .where('enabled', '=', true)
            .executeTakeFirst();
          if (Number(updated.numUpdatedRows ?? 0) === 0) {
            await transaction
              .insertInto('infra.server_extensions')
              .values({
                server_id: serverId,
                extension_id: extensionId,
                enabled: false,
                health: {},
                enabled_by: actorId,
              })
              .onConflict((conflict) => conflict
                .columns(['server_id', 'extension_id'])
                .doUpdateSet({ enabled: false }))
              .execute();
          }
          await this.audit.append(
            transaction,
            actorId,
            AuditAction.UpdateServerExtension,
            serverId,
            'server',
            { extensionId, enabled: false },
          );
        });
      } catch (error) {
        if (isOccupiedSqlError(error)) throw occupiedError(extensionId);
        throw error;
      }
    }
    const [item] = (await this.listEnablement(serverId)).filter((row) => row.extensionId === extensionId);
    return item ?? {
      extensionId: ext.id,
      displayName: ext.displayName,
      enabled: input.enabled,
      health: {},
      occupiedDeviceCount: 0,
    };
  }

  async listDevicesForAdmin(
    serverId: string,
    extensionId: string,
  ): Promise<ExtensionDevicesResponseDto> {
    const ext = this.requireRegistered(extensionId, true);
    await this.requireServer(serverId);
    const enabled = await this.claims.isEnabled(serverId, extensionId);
    const { resources, metricSamples } = await this.loadInventory(serverId);
    const listed = await ext.listDevices({
      serverId,
      resources,
      metricSamples,
      grantPayload: null,
      admin: true,
      enabled,
    });
    return { items: [...listed.items], enabled };
  }

  async listDevicesForUser(
    userId: string,
    serverId: string,
    extensionId: string,
  ): Promise<ExtensionDevicesResponseDto> {
    const ext = this.requireRegistered(extensionId, true);
    const grant = await this.access.resolveServer(userId, serverId);
    if (!grant || grant.accessPhase !== 'live') {
      throw new NotFoundException('Server not found');
    }
    const enabled = await this.claims.isEnabled(serverId, extensionId);
    if (!enabled) {
      throw new NotFoundException({
        code: FailureCode.ExtensionNotEnabled,
        message: 'The server extension is not enabled',
        details: { extensionId },
      });
    }
    const { resources, metricSamples } = await this.loadInventory(serverId);
    const listed = await ext.listDevices({
      serverId,
      resources,
      metricSamples,
      grantPayload: grant.extensionGrants[ext.id] ?? null,
      admin: false,
      enabled,
    });
    return { items: [...listed.items], enabled: true };
  }

  async enabledIdsForServers(serverIds: readonly string[]): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    if (serverIds.length === 0) return result;
    const rows = await this.database
      .selectFrom('infra.server_extensions')
      .select(['server_id', 'extension_id'])
      .where('server_id', 'in', [...serverIds])
      .where('enabled', '=', true)
      .execute();
    for (const row of rows) {
      const list = result.get(row.server_id) ?? [];
      list.push(row.extension_id);
      result.set(row.server_id, list);
    }
    return result;
  }

  async healthByServer(serverIds: readonly string[]): Promise<Map<string, Record<string, Record<string, unknown>>>> {
    const result = new Map<string, Record<string, Record<string, unknown>>>();
    if (serverIds.length === 0) return result;
    const rows = await this.database
      .selectFrom('infra.server_extensions')
      .select(['server_id', 'extension_id', 'health', 'enabled'])
      .where('server_id', 'in', [...serverIds])
      .execute();
    for (const row of rows) {
      const bag = result.get(row.server_id) ?? {};
      bag[row.extension_id] = asJsonObject(row.health);
      result.set(row.server_id, bag);
    }
    return result;
  }

  actor(userId: string, admin: boolean): ExtensionActor {
    return { userId, admin };
  }

  grantView(extensionGrants: Record<string, unknown> | null | undefined): ExtensionGrantView {
    return { extensionGrants: extensionGrants ?? null };
  }

  async purgeServerExtensions(
    serverId: string,
    transaction: Transaction<NyabaseDatabase>,
  ): Promise<void> {
    for (const ext of this.registry.all()) {
      await ext.purgeServer({
        serverId,
        claims: this.claims.forServer(ext.id, serverId, transaction),
      });
    }
    await transaction
      .deleteFrom('infra.server_extensions')
      .where('server_id', '=', serverId)
      .execute();
  }

  async refreshExistingHealth(
    serverId: string,
    resources: unknown,
    metricSamples: readonly { name: string; labels: Readonly<Record<string, string>>; value: number }[],
  ): Promise<void> {
    const rows = await this.database
      .selectFrom('infra.server_extensions')
      .select('extension_id')
      .where('server_id', '=', serverId)
      .execute();
    for (const row of rows) {
      const ext = this.registry.get(row.extension_id);
      if (!ext) continue;
      await ext.refreshHealth({
        health: this.claims.health(serverId, row.extension_id),
        serverId,
        resources,
        metricSamples,
      });
    }
  }

  private async requireServer(serverId: string): Promise<void> {
    const row = await this.database
      .selectFrom('infra.servers')
      .select('id')
      .where('id', '=', serverId)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Server not found');
  }

  private async loadInventory(serverId: string): Promise<{
    resources: unknown;
    metricSamples: readonly { name: string; labels: Readonly<Record<string, string>>; value: number }[];
  }> {
    let resources: unknown = null;
    if (this.clients) {
      try {
        resources = (await this.clients.get(serverId).then((client) => client.getResources())).metadata;
      } catch {
        resources = null;
      }
    }
    const server = await this.database
      .selectFrom('infra.servers')
      .select(['node_metrics_endpoint', 'node_metrics_token_ciphertext'])
      .where('id', '=', serverId)
      .executeTakeFirst();
    let metricSamples: { name: string; labels: Readonly<Record<string, string>>; value: number }[] = [];
    if (
      this.nodeMetrics
      && server?.node_metrics_endpoint
      && server.node_metrics_token_ciphertext
    ) {
      try {
        const pulled = await this.nodeMetrics.pull(
          serverId,
          server.node_metrics_endpoint,
          server.node_metrics_token_ciphertext,
        );
        metricSamples = [...(pulled.report?.samples ?? [])];
      } catch {
        metricSamples = [];
      }
    }
    return { resources, metricSamples };
  }
}
