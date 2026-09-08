import type { StorageDiscoverIssueDto, StoragePoolCapabilityDto } from '@nyabase/common';
import { FailureCode } from '@nyabase/common';
import { ApiError, apiErrorDetails } from './api-error.js';
import { approxGibHint, formatBytes } from './utils.js';

export type ShrinkPath = 'grow' | 'unchanged' | 'online' | 'requires_stop' | 'never';

export interface VolumeShrinkAttachmentRef {
  attachmentId: string;
  containerId: string;
  containerPath: string;
  readOnly?: boolean;
  containerName?: string;
}

/**
 * Classify a size change using the pool capability descriptor only.
 * Frontend must not hardcode Incus driver / filesystem tables.
 */
export function classifySizeChange(
  capability: StoragePoolCapabilityDto,
  currentBytes: number,
  nextBytes: number,
): ShrinkPath {
  if (!Number.isFinite(nextBytes) || nextBytes <= 0) return 'unchanged';
  if (nextBytes > currentBytes) return 'grow';
  if (nextBytes === currentBytes) return 'unchanged';
  if (capability.shrinkNever) return 'never';
  if (capability.shrinkRequiresStop) return 'requires_stop';
  // Quota-online pools with shrinkOnline:false cannot shrink (quota ineffective).
  if (!capability.shrinkOnline) return 'never';
  return 'online';
}

/** Quota-online family when the pool cannot enforce custom quotas. */
export function isQuotaIneffectiveCapability(capability: StoragePoolCapabilityDto): boolean {
  return !capability.shrinkOnline && !capability.shrinkRequiresStop && !capability.shrinkNever;
}

export function quotaIneffectiveCreateHint(): string {
  return '所选存储池配额未生效或未知，无法创建数据卷。';
}

export function quotaIneffectiveResizeHint(): string {
  return '此存储池配额未生效，无法调整数据卷容量。';
}

/**
 * Root disk observed usage. Pending desired size is never treated as used.
 */
export function observedRootUsedBytes(container: {
  rootUsedBytes?: unknown;
  rootSizePendingBytes?: unknown;
}): number | null {
  void container.rootSizePendingBytes;
  return typeof container.rootUsedBytes === 'number' && Number.isFinite(container.rootUsedBytes)
    ? container.rootUsedBytes
    : null;
}

export function formatObservedUsage(usedBytes: number | null): string {
  if (usedBytes === null) return '未知';
  return approxGibHint(usedBytes).replace(/^约 /, '');
}

export function validateShrinkFloor(
  capability: StoragePoolCapabilityDto,
  nextBytes: number,
  usedBytes: number | null,
  currentSizeBytes?: number,
): string | null {
  void currentSizeBytes;
  if (!capability.enforceUsageFloor && !capability.shrinkOnline) return null;
  if (capability.enforceUsageFloor && usedBytes === null) {
    return '已用量未知，无法缩容';
  }
  if (usedBytes !== null && nextBytes < usedBytes) {
    return `目标容量不能小于已用量（${formatBytes(usedBytes)}）`;
  }
  return null;
}

export function shrinkNeverTooltip(): string {
  return '此存储池不支持缩容；可新建更小卷并迁移数据。';
}

export function parseVolumeShrinkAttachments(error: unknown): VolumeShrinkAttachmentRef[] {
  if (!(error instanceof ApiError) || error.code !== FailureCode.VolumeShrinkRequiresDetach) {
    return [];
  }
  const details = apiErrorDetails(error);
  const raw = details?.attachments;
  if (!Array.isArray(raw)) return [];
  const attachments: VolumeShrinkAttachmentRef[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    if (
      typeof row.attachmentId !== 'string'
      || typeof row.containerId !== 'string'
      || typeof row.containerPath !== 'string'
    ) {
      continue;
    }
    attachments.push({
      attachmentId: row.attachmentId,
      containerId: row.containerId,
      containerPath: row.containerPath,
      ...(typeof row.readOnly === 'boolean' ? { readOnly: row.readOnly } : {}),
      ...(typeof row.containerName === 'string' && row.containerName.length > 0
        ? { containerName: row.containerName }
        : {}),
    });
  }
  return attachments;
}

export interface SharedBackendFsidConflict {
  identityKey: string | null;
  expectedFsid: string | null;
  conflictingFsid: string | null;
  message: string;
  details: Record<string, unknown>;
}

export function parseSharedBackendFsidConflict(error: unknown): SharedBackendFsidConflict | null {
  if (!(error instanceof ApiError) || error.code !== FailureCode.SharedBackendIdentityConflict) {
    return null;
  }
  const details = apiErrorDetails(error) ?? {};
  const identityKey = stringField(details, 'identityKey')
    ?? stringField(details, 'existingIdentityKey');
  const expectedFsid = stringField(details, 'expectedFsid');
  const conflictingFsid = stringField(details, 'discoveredFsid')
    ?? stringField(details, 'requestedFsid');
  return {
    identityKey,
    expectedFsid,
    conflictingFsid,
    message: error.message,
    details,
  };
}

export function identityConflictFromDiscoverIssue(
  issue: StorageDiscoverIssueDto,
): SharedBackendFsidConflict | null {
  if (issue.code !== FailureCode.SharedBackendIdentityConflict) return null;
  return {
    identityKey: issue.identityKey ?? issue.existingIdentityKey,
    expectedFsid: issue.expectedFsid,
    conflictingFsid: issue.discoveredFsid,
    message: issue.message,
    details: {
      identityKey: issue.identityKey,
      expectedFsid: issue.expectedFsid,
      discoveredFsid: issue.discoveredFsid,
      existingIdentityKey: issue.existingIdentityKey,
      serverId: issue.serverId,
      incusName: issue.incusName,
      poolId: issue.poolId,
    },
  };
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export async function waitUntil(
  predicate: () => Promise<boolean>,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    label?: string;
    onTimeout?: () => Promise<string | null | undefined>;
  } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 1_500;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }
  const label = options.label ?? '操作';
  let extra: string | null = null;
  try {
    extra = (await options.onTimeout?.()) ?? null;
  } catch {
    extra = null;
  }
  if (extra && extra.trim().length > 0) {
    throw new Error(extra);
  }
  throw new Error(`${label}超时，请检查容器状态后重试`);
}

export function formatDetachProgress(
  succeeded: number,
  total: number,
  failureIndex: number | null,
  failureMessage: string | null,
): string {
  if (failureIndex === null) {
    return `已卸载 ${succeeded}/${total}`;
  }
  return `卸载成功 ${succeeded} 个，第 ${failureIndex + 1} 个失败${failureMessage ? `：${failureMessage}` : ''}`;
}
