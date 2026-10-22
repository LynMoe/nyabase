import {
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  FailureCode,
  zPatchServerGpuRequest,
  type GpuDevicesResponseDto,
  type GpuGrant,
  type GpuHealthDto,
  type ListScope,
  type GpuSupportDto,
  type NodeMetricSample,
  type ServerGpuDto,
  Role,
} from '@nyabase/common';
import type { Kysely } from 'kysely';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { resolveServerAccess } from '../iam/effective-access.js';
import { AuditService } from '../iam/audit.service.js';
import { assertListScope, type Actor, requireUserId } from '../iam/actor.js';
import { INCUS_CLIENT_FACTORY, type IncusClientFactory } from '../incus/incus-client.factory.js';
import { AgentNodeMetricsPullAdapter } from '../metrics/node-metrics-pull.adapter.js';
import { assertGpuCanDisable, gpuOccupiedError, isGpuOccupiedSqlError } from './admit.js';
import { GpuClaimsRepository } from './gpu-claims.repository.js';
import { listGpuDevices, refreshGpuHealth, probeGpuSupport } from './inventory.js';
import { assertActorRole } from '../iam/administration.js';

const FAILED_HOST_PROBE: GpuSupportDto = {
  supported: null,
  checks: [{
    id: 'probe',
    label: '模块自检',
    status: 'unknown',
    detail: '自检失败',
  }],
};

@Injectable()
export class GpuService {
  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly transactions: PgTransactionManager,
    private readonly claims: GpuClaimsRepository,
    private readonly audit: AuditService,
    @Inject(INCUS_CLIENT_FACTORY) private readonly clients: IncusClientFactory,
    private readonly nodeMetrics: AgentNodeMetricsPullAdapter,
  ) {}

  /** Admin view: switch, operational health, claim count, and host prerequisites. */
  async getServerGpu(serverId: string): Promise<ServerGpuDto> {
    const server = await this.requireServer(serverId);
    const { resources, metricSamples } = await this.loadInventory(serverId);
    const occupiedDeviceCount = await this.claims.countForServer(serverId);
    return {
      enabled: server.gpu_enabled === true,
      health: server.gpu_health as GpuHealthDto,
      occupiedDeviceCount,
      support: this.probeSupportSafe(resources, metricSamples),
    };
  }

  async setEnabled(actorId: string, serverId: string, body: unknown): Promise<ServerGpuDto> {
    const input = zPatchServerGpuRequest.parse(body);
    await this.requireServer(serverId);
    if (input.enabled) {
      await this.transactions.run(async (transaction) => {
        await assertActorRole(transaction, actorId, Role.Operator);
        await transaction
          .updateTable('infra.servers')
          .set({ gpu_enabled: true, gpu_enabled_by: actorId })
          .where('id', '=', serverId)
          .execute();
        await this.audit.append(
          transaction,
          actorId,
          AuditAction.UpdateServerGpu,
          serverId,
          'server',
          { enabled: true },
        );
      });
      const { resources, metricSamples } = await this.loadInventory(serverId);
      await refreshGpuHealth({
        health: this.claims.health(serverId),
        resources,
        metricSamples,
      });
    } else {
      try {
        await this.transactions.run(async (transaction) => {
          await assertActorRole(transaction, actorId, Role.Operator);
          await assertGpuCanDisable({
            count: () => this.claims.countForServer(serverId, transaction),
          });
          await transaction
            .updateTable('infra.servers')
            .set({ gpu_enabled: false })
            .where('id', '=', serverId)
            .execute();
          await this.audit.append(
            transaction,
            actorId,
            AuditAction.UpdateServerGpu,
            serverId,
            'server',
            { enabled: false },
          );
        });
      } catch (error) {
        if (isGpuOccupiedSqlError(error)) throw gpuOccupiedError();
        throw error;
      }
    }
    return this.getServerGpu(serverId);
  }

  /** `scope=mine`: devices the caller's grant allows; `scope=all`: the full inventory (`ManageServers`/`ManageGrants`). */
  async listDevices(actor: Actor, serverId: string, scope: ListScope): Promise<GpuDevicesResponseDto> {
    assertListScope(actor, scope, Role.Operator);
    return scope === 'all'
      ? this.listAllDevices(serverId)
      : this.listGrantedDevices(requireUserId(actor), serverId);
  }

  private async listAllDevices(serverId: string): Promise<GpuDevicesResponseDto> {
    const server = await this.requireServer(serverId);
    const { resources, metricSamples } = await this.loadInventory(serverId);
    return {
      items: listGpuDevices({ resources, metricSamples, grant: null, admin: true }),
      enabled: server.gpu_enabled === true,
    };
  }

  /** Devices the caller's server grant allows; unavailable while GPU is disabled. */
  private async listGrantedDevices(userId: string, serverId: string): Promise<GpuDevicesResponseDto> {
    const grant = await resolveServerAccess(this.database, userId, serverId);
    if (!grant) {
      throw new NotFoundException('Server not found');
    }
    if (!(await this.claims.isEnabled(serverId))) {
      throw new NotFoundException({
        code: FailureCode.GpuNotEnabled,
        message: 'GPU is not enabled on this server',
      });
    }
    const { resources, metricSamples } = await this.loadInventory(serverId);
    const allowed: GpuGrant = { pciAddresses: grant.gpuPciAddresses };
    return {
      items: listGpuDevices({ resources, metricSamples, grant: allowed, admin: false }),
      enabled: true,
    };
  }

  async refreshHealth(
    serverId: string,
    resources: unknown,
    metricSamples: readonly NodeMetricSample[],
  ): Promise<void> {
    await refreshGpuHealth({
      health: this.claims.health(serverId),
      resources,
      metricSamples,
    });
  }

  private probeSupportSafe(
    resources: unknown,
    metricSamples: readonly NodeMetricSample[],
  ): GpuSupportDto {
    try {
      return probeGpuSupport({ resources, metricSamples });
    } catch {
      return FAILED_HOST_PROBE;
    }
  }

  private async requireServer(serverId: string) {
    const row = await this.database
      .selectFrom('infra.servers')
      .select(['id', 'gpu_enabled', 'gpu_health'])
      .where('id', '=', serverId)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Server not found');
    return row;
  }

  private async loadInventory(serverId: string): Promise<{
    resources: unknown;
    metricSamples: readonly NodeMetricSample[];
  }> {
    let resources: unknown = null;
    try {
      resources = (await this.clients.get(serverId).then((client) => client.getResources())).metadata;
    } catch {
      resources = null;
    }
    let metricSamples: NodeMetricSample[] = [];
    try {
      const pulled = await this.nodeMetrics.pull(serverId);
      metricSamples = [...(pulled.report?.samples ?? [])];
    } catch {
      metricSamples = [];
    }
    return { resources, metricSamples };
  }
}
