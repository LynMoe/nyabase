import {
  ContainerPhase,
  ContainerPowerIntent,
  ContainerStatus,
  IntentResourceType,
  StoragePoolResizeFamily,
  parseContainerState,
  type ContainerDto,
  type VolumeAttachmentDto,
} from '@nyabase/common';
import type { Kysely } from 'kysely';
import { isoDate, nullableNumber, numberValue, poolLabel } from '../platform/domain-utils.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import type { NyabaseConfigService } from '../platform/config/nyabase-config.service.js';
import {
  missingStoragePoolCapability,
  storagePoolCapability,
} from '../storage-pools/storage-pool-capability.js';
import type {
  ContainerControlRepository,
  ContainerRow,
  ImageRow,
  ServerRow,
} from './container-control.repository.js';
import { containerActionAvailability, containerStatus } from './container-rules.js';

type RouteRecord = Awaited<ReturnType<ContainerControlRepository['routes']>>[number];

interface PoolRecord {
  id: string;
  display_name: string | null;
  incus_name: string;
  resize_family: string;
  quota_effective: boolean | null;
  block_filesystem: string | null;
}

/** Everything the DTOs need besides the container rows themselves. */
interface DtoContext {
  servers: Map<string, ServerRow>;
  images: Map<string, ImageRow>;
  routes: Map<string, RouteRecord>;
  pools: Map<string, PoolRecord>;
  owners: Map<string, string>;
  pending: Set<string>;
  localVolumes: Map<string, VolumeAttachmentDto[]>;
  sharedVolumes: Map<string, VolumeAttachmentDto[]>;
}

function phase(value: string): ContainerPhase {
  return value as ContainerPhase;
}

function toAttachmentDto(
  attachment: {
    id: string;
    container_id: string;
    volume_id: string;
    device_name: string;
    container_path: string;
    read_only: boolean;
    bind_state: VolumeAttachmentDto['bindState'];
    created_at: Date | string;
    updated_at: Date | string;
  },
  volumeName: string,
  extra: { kind: 'local' | 'shared'; catalogState: string | null },
): VolumeAttachmentDto {
  return {
    id: attachment.id,
    containerId: attachment.container_id,
    volumeId: attachment.volume_id,
    volumeName,
    deviceName: attachment.device_name,
    containerPath: attachment.container_path,
    readOnly: attachment.read_only,
    bindState: attachment.bind_state,
    kind: extra.kind,
    onlineCancelAllowed: extra.catalogState !== 'present' && attachment.bind_state === 'attaching',
    createdAt: new Date(attachment.created_at).toISOString(),
    updatedAt: new Date(attachment.updated_at).toISOString(),
  };
}

/** Turns container rows into DTOs, loading the servers, images, routes, pools and volumes they reference. */
export class ContainerDtoAssembler {
  constructor(
    private readonly database: Kysely<NyabaseDatabase>,
    private readonly repository: ContainerControlRepository,
    private readonly config: NyabaseConfigService,
  ) {}

  private async loadAttachmentDtos(
    containerIds: readonly string[],
  ): Promise<Pick<DtoContext, 'localVolumes' | 'sharedVolumes'>> {
    const attachments = await this.database.selectFrom('control.volume_attachments as attachment')
      .innerJoin('control.volumes as volume', 'volume.id', 'attachment.volume_id')
      .leftJoin('control.containers as container', 'container.id', 'attachment.container_id')
      .leftJoin('control.volume_placements as placement', (join) => join
        .onRef('placement.volume_id', '=', 'attachment.volume_id')
        .onRef('placement.server_id', '=', 'container.server_id'))
      .selectAll('attachment')
      .select([
        'volume.name as volume_name',
        'volume.shared_backend_id as shared_backend_id',
        'placement.catalog_state as catalog_state',
      ])
      .where('attachment.container_id', 'in', [...containerIds])
      .orderBy('attachment.created_at')
      .execute();
    const localVolumes = new Map<string, VolumeAttachmentDto[]>();
    const sharedVolumes = new Map<string, VolumeAttachmentDto[]>();
    for (const attachment of attachments) {
      const kind = attachment.shared_backend_id !== null ? 'shared' : 'local';
      const dto = toAttachmentDto(attachment, attachment.volume_name, {
        kind,
        catalogState: attachment.catalog_state,
      });
      const target = kind === 'shared' ? sharedVolumes : localVolumes;
      const list = target.get(attachment.container_id) ?? [];
      list.push(dto);
      target.set(attachment.container_id, list);
    }
    return { localVolumes, sharedVolumes };
  }

  private async loadContext(
    rows: readonly ContainerRow[],
  ): Promise<DtoContext> {
    const ids = rows.map((row) => row.id);
    const serverIds = [...new Set(rows.map((row) => row.server_id))];
    const imageIds = [...new Set(rows.map((row) => row.image_id))];
    const ownerIds = [...new Set(rows.map((row) => row.owner_id))];
    const poolIds = [...new Set(rows.map((row) => row.root_pool_id))];
    const [serverRows, imageRows, routeRows] = await Promise.all([
      this.database.selectFrom('infra.servers').selectAll().where('id', 'in', serverIds).execute(),
      this.database.selectFrom('infra.images').selectAll().where('id', 'in', imageIds).execute(),
      this.repository.routes(ids),
    ]);
    const pendingRows = await this.database.selectFrom('control.intents')
      .select('resource_id')
      .where('resource_type', '=', IntentResourceType.Container)
      .where('resource_id', 'in', ids)
      .where('status', '=', 'pending')
      .execute();
    const { localVolumes, sharedVolumes } = await this.loadAttachmentDtos(ids);
    const owners = new Map<string, string>();
    if (ownerIds.length > 0) {
      const ownerRows = await this.database.selectFrom('iam.users')
        .select(['id', 'username'])
        .where('id', 'in', ownerIds)
        .execute();
      for (const owner of ownerRows) owners.set(owner.id, owner.username);
    }
    const poolRows = poolIds.length === 0
      ? []
      : await this.database.selectFrom('infra.storage_pools')
        .select([
          'id',
          'display_name',
          'incus_name',
          'resize_family',
          'quota_effective',
          'block_filesystem',
        ])
        .where('id', 'in', poolIds)
        .execute();
    return {
      servers: new Map(serverRows.map((server) => [server.id, server])),
      images: new Map(imageRows.map((image) => [image.id, image])),
      routes: new Map(routeRows.map((route) => [route.containerId, route])),
      pools: new Map(poolRows.map((pool) => [pool.id, pool])),
      owners,
      pending: new Set(pendingRows.map((item) => item.resource_id)),
      localVolumes,
      sharedVolumes,
    };
  }

  private toContainerDto(
    context: DtoContext,
    row: ContainerRow,
  ): ContainerDto {
    const server = context.servers.get(row.server_id);
    const image = context.images.get(row.image_id);
    const route = context.routes.get(row.id);
    const pool = context.pools.get(row.root_pool_id);
    const actualStatus = containerStatus(route?.runtimeStatus, row.power_intent as ContainerPowerIntent);
    const proxyHost = this.config.get<string>('ssh.proxyPublicHost')?.trim() || null;
    const proxyPort = this.config.get<number>('ssh.proxyPublicPort') || null;
    return {
      id: row.id,
      serverId: row.server_id,
      serverName: server?.name ?? row.server_id,
      ownerId: row.owner_id,
      ownerName: context.owners.get(row.owner_id),
      name: row.name,
      instanceName: route?.instanceName ?? row.instance_name,
      imageId: row.image_id,
      imageName: image?.alias,
      imageFingerprint: row.image_fingerprint,
      rootPoolId: row.root_pool_id,
      rootPoolName: pool ? poolLabel(pool.display_name, pool.incus_name) : row.root_pool_id,
      rootSizeBytes: numberValue(row.root_size_bytes),
      rootSizePendingBytes: row.root_size_pending_bytes === null
        ? null
        : numberValue(row.root_size_pending_bytes),
      rootUsedBytes: nullableNumber(row.root_used_bytes),
      rootCapability: pool
        ? storagePoolCapability(
          pool.resize_family as StoragePoolResizeFamily,
          pool.quota_effective,
          pool.block_filesystem,
        )
        : missingStoragePoolCapability(),
      cpuMillis: row.cpu_millis,
      memBytes: numberValue(row.mem_bytes),
      gpu: parseContainerState(row.gpu_state),
      powerIntent: row.power_intent as ContainerPowerIntent,
      lifecyclePhase: phase(row.lifecycle_phase),
      routedIp: route?.routedIp ?? null,
      actual: {
        instanceName: route?.instanceName ?? row.instance_name,
        status: actualStatus,
        routedIp: route?.routedIp ?? null,
        observedAt: isoDate(route?.observedAt),
      },
      ssh: {
        enabled: true,
        status: route?.sshStatus ?? 'unknown',
        ready: route?.sshStatus === 'running' && actualStatus === ContainerStatus.Running,
        loginUser: image?.login_user ?? 'root',
        proxyHost,
        proxyPort,
        observedAt: isoDate(route?.observedAt),
        lastError: route?.lastError ?? null,
      },
      volumes: context.localVolumes.get(row.id) ?? [],
      sharedVolumes: context.sharedVolumes.get(row.id) ?? [],
      needsAttention: row.needs_attention,
      failureCode: row.failure_code,
      failureReason: row.failure_reason,
      revision: row.revision,
      observedRevision: row.observed_revision,
      actions: containerActionAvailability({
        phase: phase(row.lifecycle_phase),
        runtimeStatus: actualStatus,
        runtimeReady: server?.status === 'online',
        intentPending: context.pending.has(row.id),
        sshEnabled: true,
      }),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  async toContainerDtos(
    rows: readonly ContainerRow[],
  ): Promise<ContainerDto[]> {
    if (rows.length === 0) return [];
    const context = await this.loadContext(rows);
    return rows.map((row) => this.toContainerDto(context, row));
  }
}
