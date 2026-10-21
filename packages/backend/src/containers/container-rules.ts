import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import {
  ContainerPowerIntent,
  ContainerStatus,
  FailureCode,
  StoragePoolResizeFamily,
  type CreateContainerRequest,
} from '@nyabase/common';

export interface RootResizeCheckInput {
  readonly containerId: string;
  readonly requestedBytes: number;
  readonly currentBytes: number;
  readonly usedBytes: number | null;
  readonly resizeFamily: string;
  readonly observedStatus: ContainerStatus;
}

/**
 * Quota-online roots with no observed usage (including Incus reporting 0)
 * cannot shrink. A booted image is never an empty filesystem.
 */
export function checkRootResize(
  input: RootResizeCheckInput,
): { code: FailureCode; message: string; details: Record<string, unknown> } | null {
  if (input.requestedBytes >= input.currentBytes) return null;
  if (input.resizeFamily === StoragePoolResizeFamily.BlockBacked
    && input.observedStatus !== ContainerStatus.Stopped) {
    return {
      code: FailureCode.RootShrinkRequiresStop,
      message: 'Block-backed root shrink requires a stopped container',
      details: { containerId: input.containerId },
    };
  }
  if (input.resizeFamily === StoragePoolResizeFamily.QuotaOnline) {
    if (input.usedBytes === null || input.usedBytes <= 0) {
      return {
        code: FailureCode.RootUsageUnknown,
        message: 'Root disk usage is unknown; shrink is not allowed until usage is observed',
        details: {
          containerId: input.containerId,
          requestedBytes: input.requestedBytes,
          usedBytes: input.usedBytes,
        },
      };
    }
  }
  if (input.usedBytes !== null && input.usedBytes > input.requestedBytes) {
    return {
      code: FailureCode.RootShrinkBelowUsage,
      message: 'The requested root disk size is below current usage',
      details: {
        containerId: input.containerId,
        requestedBytes: input.requestedBytes,
        usedBytes: input.usedBytes,
      },
    };
  }
  return null;
}

export function containerStatus(
  value: string | null | undefined,
  power: ContainerPowerIntent,
): ContainerStatus {
  const normalized = value?.toLowerCase();
  if (normalized === 'running') return ContainerStatus.Running;
  if (normalized === 'stopped') return ContainerStatus.Stopped;
  if (normalized === 'frozen') return ContainerStatus.Frozen;
  if (normalized === 'error') return ContainerStatus.Error;
  if (value !== null && value !== undefined) return ContainerStatus.Unknown;
  if (power === ContainerPowerIntent.Stopped) return ContainerStatus.Stopped;
  return ContainerStatus.Unknown;
}

export function assertContainerName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/.test(name)) {
    throw new BadRequestException({
      code: FailureCode.InvalidInput,
      message: 'Container name must be 1-63 characters and use letters, numbers, or hyphen',
    });
  }
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  let current: unknown = error;
  const visited = new Set<unknown>();
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const record = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (record.code === '23505') {
      if (!constraint) return true;
      return String(record.constraint ?? '').includes(constraint);
    }
    current = record.cause;
  }
  return false;
}

export function gpuDeviceClaimed(pciAddress?: string): ConflictException {
  return new ConflictException({
    code: FailureCode.GpuDeviceClaimed,
    message: 'A requested GPU is already claimed',
    details: pciAddress ? { pciAddress } : {},
  });
}

export function assertCreateNumbers(request: CreateContainerRequest): void {
  if (!Number.isSafeInteger(request.rootSizeBytes) || request.rootSizeBytes <= 0
    || !Number.isSafeInteger(request.cpuMillis) || request.cpuMillis < 0
    || !Number.isSafeInteger(request.memBytes) || request.memBytes < 0) {
    throw new BadRequestException({
      code: FailureCode.InvalidInput,
      message: 'Container resource limits must be non-negative safe integers with a positive root size',
    });
  }
}

export function stringArray(value: string[] | string | null | undefined): string[] {
  if (Array.isArray(value)) return [...value];
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function assertComputeGrant(
  grant: { cpuMillis: number | null; memBytes: number | null },
  cpuMillis: number,
  memBytes: number,
): void {
  if (grant.cpuMillis !== null && cpuMillis > grant.cpuMillis) {
    throw new ForbiddenException({
      code: FailureCode.PermissionDenied,
      message: 'The requested CPU exceeds the server grant',
      details: { requestedCpuMillis: cpuMillis, grantCpuMillis: grant.cpuMillis },
    });
  }
  if (grant.memBytes !== null && memBytes > grant.memBytes) {
    throw new ForbiddenException({
      code: FailureCode.PermissionDenied,
      message: 'The requested memory exceeds the server grant',
      details: { requestedMemBytes: memBytes, grantMemBytes: grant.memBytes },
    });
  }
}
