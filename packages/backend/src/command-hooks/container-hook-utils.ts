import type { ContainerMountSpec, ContainerSnapshot } from '@nyabase/common';
import type { ContainerDesiredSpecEntity } from '../entities/container-desired-spec.entity.js';

export type DesiredMount = {
  id?: string;
  sourceKind: 'local' | 'remote';
  sourceId: string;
  dirName: string;
  containerPath: string;
};

export function desiredMounts(desired: ContainerDesiredSpecEntity | null | undefined): DesiredMount[] {
  const mounts = Array.isArray(desired?.mountsJson) ? desired.mountsJson as DesiredMount[] : [];
  return mounts.map((mount, index) => ({
    id: mount.id ?? `${mount.sourceKind}:${mount.sourceId}:${mount.dirName}:${index}`,
    sourceKind: mount.sourceKind,
    sourceId: mount.sourceId,
    dirName: mount.dirName,
    containerPath: mount.containerPath,
  }));
}

export function runtimeIdFromResult(result: unknown): string | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const value = (result as Record<string, unknown>).runtimeId;
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

export function runtimeIdFromSnapshot(snapshot: ContainerSnapshot | undefined): string | null {
  const value = snapshot?.spec.runtimeId;
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

export function payloadRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
}

export function expectedMountSpecs(payload: unknown): ContainerMountSpec[] | null {
  const record = payloadRecord(payload);
  return Array.isArray(record.expected) ? record.expected as ContainerMountSpec[] : null;
}

export function removedMountPaths(payload: unknown): string[] | undefined {
  const record = payloadRecord(payload);
  return Array.isArray(record.toRemove) ? record.toRemove.map(String) : undefined;
}
