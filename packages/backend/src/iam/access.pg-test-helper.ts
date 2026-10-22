import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { Capability, UserStatus } from '@nyabase/common';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';

/** Row seeders for PostgreSQL tests of the authorization model. */
type Db = Kysely<NyabaseDatabase>;

let nextNumericId = 1;
let nextName = 1;

export async function seedUser(
  database: Db,
  username = `user-${nextName++}`,
  status: UserStatus = UserStatus.Active,
): Promise<string> {
  const id = randomUUID();
  await database.insertInto('iam.users').values({
    id,
    numeric_id: nextNumericId++,
    username,
    password_hash: 'unused',
    display_name: username,
    status,
    auth_version: 0,
  }).execute();
  return id;
}

export async function seedGroup(
  database: Db,
  options: {
    name?: string;
    capabilities?: Capability[];
    system?: 'administrators' | 'operators' | 'users';
  } = {},
): Promise<string> {
  const id = randomUUID();
  await database.insertInto('iam.groups').values({
    id,
    name: options.name ?? `group-${nextName++}`,
    description: null,
    is_system: options.system !== undefined,
    system_key: options.system ?? null,
    capabilities: options.capabilities ?? [],
    revision: 1,
  }).execute();
  return id;
}

export async function addMember(database: Db, groupId: string, userId: string): Promise<void> {
  await database.insertInto('iam.group_members').values({
    id: randomUUID(),
    group_id: groupId,
    user_id: userId,
  }).execute();
}

export async function seedServer(database: Db, name = `server-${nextName++}`): Promise<string> {
  const id = randomUUID();
  await database.insertInto('infra.servers').values({
    id,
    name,
    slug: `${name}-${id.slice(0, 8)}`,
    incus_version: null,
    api_extensions: [],
    system_pool_id: null,
    storage_overcommit_ratio: 1,
    parent_interface: 'eth0',
    dns_servers: ['10.20.0.1'],
    status: 'online',
    last_seen_at: null,
    last_error: null,
    revision: 1,
    node_metrics_status: 'unknown',
    node_metrics_last_success_at: null,
    node_metrics_outage_since: null,
    node_metrics_last_error: null,
    preflight_status: 'not_run',
    preflight_checked_at: null,
    preflight_report: null,
  }).execute();
  return id;
}

export async function seedPool(database: Db, serverId: string): Promise<string> {
  const id = randomUUID();
  await database.insertInto('infra.storage_pools').values({
    id,
    server_id: serverId,
    incus_name: `pool-${id.slice(0, 8)}`,
    driver: 'dir',
    resize_family: 'quota_online',
    root_disk_capable: true,
    shareable: false,
    block_filesystem: null,
    shared_backend_id: null,
    total_bytes: 1000,
    used_bytes: 0,
    quota_effective: true,
    display_name: null,
    registered: true,
    last_observed_at: new Date(),
    revision: 1,
  }).execute();
  return id;
}

export async function seedBackend(database: Db): Promise<string> {
  const id = randomUUID();
  await database.insertInto('infra.shared_backends').values({
    id,
    name: `backend-${id.slice(0, 8)}`,
    display_name: null,
    identity_key: `identity-${id}`,
    ceph_fsid: randomUUID(),
    total_bytes: null,
    used_bytes: null,
    overcommit_ratio: 1,
    revision: 1,
  }).execute();
  return id;
}

export async function seedImage(database: Db): Promise<string> {
  const id = randomUUID();
  await database.insertInto('infra.images').values({
    id,
    alias: `image-${id.slice(0, 8)}`,
    fingerprint: 'a'.repeat(64),
    description: null,
    login_user: 'root',
    min_root_size_bytes: null,
    network_managed_externally: true,
    is_active: true,
    deleting: false,
    cleanup_generation: 0,
    revision: 1,
  }).execute();
  return id;
}

export async function seedContainer(
  database: Db,
  input: {
    ownerId: string;
    serverId: string;
    poolId: string;
    imageId: string;
    running?: boolean;
  },
): Promise<string> {
  const id = randomUUID();
  await database.insertInto('control.containers').values({
    id,
    server_id: input.serverId,
    owner_id: input.ownerId,
    image_id: input.imageId,
    created_by: input.ownerId,
    name: `container-${id.slice(0, 8)}`,
    revision: 1,
    observed_revision: null,
    image_alias: 'base',
    image_fingerprint: 'a'.repeat(64),
    root_pool_id: input.poolId,
    root_size_bytes: 100,
    root_size_pending_bytes: null,
    mem_bytes: 1_073_741_824,
    nesting: true,
    syscall_intercept: true,
    power_intent: input.running ? 'running' : 'stopped',
    lifecycle_phase: 'active',
    instance_name: null,
    needs_attention: false,
    failure_code: null,
    failure_reason: null,
  }).execute();
  return id;
}

export async function seedVolume(
  database: Db,
  input: {
    ownerId: string;
    poolId: string | null;
    serverId: string | null;
    sharedBackendId?: string | null;
  },
): Promise<string> {
  const id = randomUUID();
  await database.insertInto('control.volumes').values({
    id,
    owner_id: input.ownerId,
    pool_id: input.sharedBackendId ? null : input.poolId,
    server_id: input.serverId,
    shared_backend_id: input.sharedBackendId ?? null,
    name: `volume-${id.slice(0, 8)}`,
    incus_name: `nyv-${id.replaceAll('-', '')}`,
    size_bytes: 100,
    used_bytes: 0,
    revision: 1,
    observed_revision: 1,
    lifecycle_phase: 'active',
    needs_attention: false,
    failure_code: null,
  }).execute();
  return id;
}

type Subject = { user: string } | { group: string };

function subject(value: Subject) {
  return 'user' in value
    ? { user_id: value.user, group_id: null }
    : { user_id: null, group_id: value.group };
}

export async function grantServer(
  database: Db,
  who: Subject,
  serverId: string,
  values: {
    cpuCores?: number | null;
    memBytes?: number | null;
    diskBytes?: number | null;
    gpu?: string[];
    expiresAt?: Date | null;
  } = {},
): Promise<void> {
  await database.insertInto('iam.server_grants').values({
    id: randomUUID(),
    ...subject(who),
    server_id: serverId,
    cpu_cores: values.cpuCores ?? null,
    mem_bytes: values.memBytes ?? null,
    disk_bytes: values.diskBytes ?? null,
    gpu_pci_addresses: values.gpu ?? [],
    expires_at: values.expiresAt ?? null,
  }).execute();
}

export async function grantPool(
  database: Db,
  who: Subject,
  poolId: string,
  expiresAt: Date | null = null,
): Promise<void> {
  await database.insertInto('iam.storage_pool_grants').values({
    id: randomUUID(),
    ...subject(who),
    pool_id: poolId,
    expires_at: expiresAt,
  }).execute();
}

export async function grantBackend(
  database: Db,
  who: Subject,
  backendId: string,
  limitBytes: number,
  expiresAt: Date | null = null,
): Promise<void> {
  await database.insertInto('iam.shared_backend_grants').values({
    id: randomUUID(),
    ...subject(who),
    shared_backend_id: backendId,
    limit_bytes: limitBytes,
    expires_at: expiresAt,
  }).execute();
}

export const days = (count: number): Date => new Date(Date.now() + count * 24 * 60 * 60 * 1000);

/** A registered CephFS pool through which `serverId` reaches the shared backend. */
export async function seedBackendPool(
  database: Db,
  serverId: string,
  backendId: string,
): Promise<string> {
  const id = randomUUID();
  await database.insertInto('infra.storage_pools').values({
    id,
    server_id: serverId,
    incus_name: `ceph-${id.slice(0, 8)}`,
    driver: 'cephfs',
    resize_family: 'quota_online',
    root_disk_capable: false,
    shareable: true,
    block_filesystem: null,
    shared_backend_id: backendId,
    total_bytes: null,
    used_bytes: null,
    quota_effective: true,
    display_name: null,
    registered: true,
    last_observed_at: new Date(),
    revision: 1,
  }).execute();
  return id;
}

export async function seedAttachment(
  database: Db,
  containerId: string,
  volumeId: string,
): Promise<string> {
  const id = randomUUID();
  await database.insertInto('control.volume_attachments').values({
    id,
    container_id: containerId,
    volume_id: volumeId,
    device_name: `nyd-${id.replaceAll('-', '')}`,
    container_path: `/data-${id.slice(0, 8)}`,
    read_only: false,
    bind_state: 'attached',
  }).execute();
  return id;
}
