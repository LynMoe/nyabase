import { createHash } from 'node:crypto';
import { AuditAction } from '@nyabase/common';
import {
  CORE_MANAGED_FIELD_OWNERSHIP,
  IncusError,
  type IncusSchema,
  type ManagedFieldOwnership,
} from '../incus/index.js';
import { GPU_CONFIG_PREFIXES, GPU_DEVICE_PREFIXES } from '../gpu/instance-spec.js';
import type { AuditService } from '../iam/audit.service.js';
import type { IntentFailure, IntentRecord } from '../reconcile/intent.repository.js';
import type { SshdPresence } from './container-ssh-state.adapter.js';

/** Managed Incus fields: core plus the NVIDIA GPU config and device prefixes. */
export const MANAGED_FIELD_OWNERSHIP: ManagedFieldOwnership = {
  configPrefixes: [...CORE_MANAGED_FIELD_OWNERSHIP.configPrefixes, ...GPU_CONFIG_PREFIXES],
  deviceNames: CORE_MANAGED_FIELD_OWNERSHIP.deviceNames,
  devicePrefixes: [...CORE_MANAGED_FIELD_OWNERSHIP.devicePrefixes, ...GPU_DEVICE_PREFIXES],
};
export type InstanceFull = IncusSchema<'InstanceFull'>;
export type InstanceState = IncusSchema<'InstanceState'>;

export const MANAGED_KEY = 'user.nyabase.managed';
export const CONTAINER_ID_KEY = 'user.nyabase.container_id';
export const SERVER_ID_KEY = 'user.nyabase.server_id';

export interface ContainerRow {
  id: string;
  server_id: string;
  owner_id: string;
  image_id: string;
  revision: number;
  image_fingerprint: string;
  root_size_bytes: string | number;
  cpu_millis: number;
  mem_bytes: string | number;
  gpu_enabled: boolean;
  gpu_state: unknown;
  nesting: boolean;
  syscall_intercept: boolean;
  power_intent: 'running' | 'stopped';
  lifecycle_phase: 'provisioning' | 'active' | 'deleting' | 'failed';
  root_pool_name: string;
  root_resize_family: 'quota_online' | 'block_backed';
  parent_interface: string | null;
  routed_ip: string | null;
  network_key: string | null;
  gateway: string | null;
  dns_servers: string[];
  login_user: string;
  ssh_public_key: string | null;
}
export interface ContainerAttachment {
  id: string;
  container_path: string;
  read_only: boolean;
  volume_id: string;
  incus_name: string;
  pool_name: string;
  size_bytes: string;
  shared: boolean;
  bind_state: 'attaching' | 'attached' | 'detaching';
}

export interface ActualInstance {
  readonly name: string;
  readonly document: InstanceFull;
}

export interface SshFileMetadataExpectation {
  readonly uid?: number;
  readonly gid?: number;
  readonly mode: number;
  readonly type: 'file';
}

export interface SshFileObservation {
  readonly status: 'disabled' | 'container_stopped' | 'running' | 'error' | 'unknown';
  readonly lastError: string | null;
}

export interface ManagedContainerIdentity {
  readonly managed: boolean;
  readonly containerId: string;
  readonly serverId: string;
}

export function isNotFound(error: unknown): boolean {
  return error instanceof IncusError && error.code === 'INCUS_NOT_FOUND';
}

export function failure(code: string, message: string, details: Record<string, unknown> = {}): IntentFailure {
  return { code, message, details };
}

export async function auditIncusMutate(
  audit: AuditService,
  intent: IntentRecord,
  detail: {
    readonly method: string;
    readonly path: string;
    readonly instanceName?: string;
  },
): Promise<void> {
  await audit.log(
    intent.requestedBy,
    AuditAction.IncusMutate,
    intent.resourceId,
    intent.resourceType,
    {
      method: detail.method,
      path: detail.path,
      instanceName: detail.instanceName,
      serverId: intent.serverId,
      intentId: intent.id,
    },
  );
}

export function normalized(value: unknown): string {
  return typeof value === 'string' ? value.replaceAll('-', '').toLowerCase() : '';
}

export function managedContainerIdentity(document: InstanceFull): ManagedContainerIdentity {
  const config = document.config ?? {};
  return {
    managed: config[MANAGED_KEY] === 'true',
    containerId: normalized(config[CONTAINER_ID_KEY]),
    serverId: normalized(config[SERVER_ID_KEY]),
  };
}

export function powerTransition(
  currentStatus: string | undefined,
  desired: 'running' | 'stopped',
): 'start' | 'stop' | 'none' {
  const current = currentStatus?.toLowerCase();
  if (desired === 'running') return current === 'running' ? 'none' : 'start';
  return current === 'running' ? 'stop' : 'none';
}

export function restartTransition(
  currentStartedAt: string | null | undefined,
  baselineStartedAt: string | null | undefined,
  currentStatus: string | undefined,
): 'restart' | 'proven' {
  if (
    currentStatus?.toLowerCase() === 'running'
    && currentStartedAt !== baselineStartedAt
  ) {
    return 'proven';
  }
  return 'restart';
}

export function running(state: InstanceState | undefined): boolean {
  return state?.status?.toLowerCase() === 'running';
}

export function observedDiskUsageBytes(value: unknown): bigint | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  return null;
}

export function bytes(value: unknown): bigint | null {
  return observedDiskUsageBytes(value);
}

export type RootShrinkBlock = 'usage_unknown' | 'usage_floor' | 'requires_stop';

export function decideRootShrink(input: {
  readonly resizeFamily: 'quota_online' | 'block_backed';
  readonly actualRootBytes: bigint;
  readonly desiredRootBytes: bigint;
  readonly usedBytes: bigint | null;
  readonly running: boolean;
}): 'allow' | RootShrinkBlock {
  if (input.desiredRootBytes >= input.actualRootBytes) return 'allow';
  if (input.resizeFamily === 'block_backed' && input.running) return 'requires_stop';
  if (input.resizeFamily === 'quota_online' && (input.usedBytes === null || input.usedBytes <= 0n)) {
    return 'usage_unknown';
  }
  if (input.usedBytes !== null && input.desiredRootBytes < input.usedBytes) return 'usage_floor';
  return 'allow';
}

export function sshFileMetadataMatches(
  actual: {
    readonly uid?: number;
    readonly gid?: number;
    readonly mode?: number;
    readonly type?: string;
  },
  desired: SshFileMetadataExpectation,
): boolean {
  return actual.mode === desired.mode
    && actual.type === desired.type
    && (desired.uid === undefined || actual.uid === desired.uid)
    && (desired.gid === undefined || actual.gid === desired.gid);
}

export function sshFileNeedsReconcile(input: {
  readonly actual: {
    readonly body: Buffer;
    readonly uid?: number;
    readonly gid?: number;
    readonly mode?: number;
    readonly type?: string;
  } | null;
  readonly desiredContent: string;
  readonly desiredMetadata: SshFileMetadataExpectation;
}): boolean {
  if (!input.actual) return true;
  const desiredHash = createHash('sha256').update(input.desiredContent).digest('hex');
  const actualHash = createHash('sha256').update(input.actual.body).digest('hex');
  return desiredHash !== actualHash
    || !sshFileMetadataMatches(input.actual, input.desiredMetadata);
}

export function sshFileMetadata(
  loginUser: string,
  owner?: { readonly uid?: number; readonly gid?: number } | null,
): SshFileMetadataExpectation {
  return loginUser === 'root'
    ? { uid: 0, gid: 0, mode: 0o600, type: 'file' }
    : { uid: owner?.uid, gid: owner?.gid, mode: 0o600, type: 'file' };
}

export function sshObservation(sshd: SshdPresence): SshFileObservation {
  if (sshd === 'missing') {
    return {
      status: 'error',
      lastError: 'key_applied_sshd_missing',
    };
  }
  if (sshd === 'unknown') {
    return { status: 'unknown', lastError: null };
  }
  return { status: 'running', lastError: null };
}

/** Build guest authorized_keys from platform user public keys only (T3 jump). */
export function composeAuthorizedKeys(
  userKeys: string | null | undefined,
): string | null {
  if (!userKeys) return null;
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const line of userKeys.split('\n')) {
    const key = line.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    lines.push(key);
  }
  return lines.length > 0 ? lines.join('\n') : null;
}
