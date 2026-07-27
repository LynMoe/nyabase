import { createHash } from 'node:crypto';
import {
  AgentTaskKind,
  canonicalJson,
  parseAgentTaskPayload,
  zTaskId,
  type AgentTaskPayloadByKind,
} from '@nyabase/common';
import type { AgentTaskRecord } from '../domain/domain-records.js';

export const MAX_AGENT_TASK_WIRE_BYTES = 1024 * 1024;

export const AGENT_TASK_RESOURCE_TYPE_BY_KIND = {
  [AgentTaskKind.ContainerCreate]: 'container',
  [AgentTaskKind.ContainerStart]: 'container',
  [AgentTaskKind.ContainerStop]: 'container',
  [AgentTaskKind.ContainerRestart]: 'container',
  [AgentTaskKind.ContainerDelete]: 'container',
  [AgentTaskKind.ContainerRuntimeAbsent]: 'container_runtime',
  [AgentTaskKind.ContainerSshEnsure]: 'container',
  [AgentTaskKind.DataDirEnsure]: 'datadir',
  [AgentTaskKind.DataDirAbsent]: 'datadir',
  [AgentTaskKind.RemoteFsEnsure]: 'remote_fs_mount',
  [AgentTaskKind.RemoteFsAbsent]: 'remote_fs_mount',
  [AgentTaskKind.QuotaEnsure]: 'quota',
  [AgentTaskKind.ImageEnsurePresent]: 'image',
  [AgentTaskKind.ImageEnsureAbsent]: 'image',
} as const satisfies Record<AgentTaskKind, string>;

type DurableTaskIdentity = Pick<
  AgentTaskRecord,
  'kind' | 'resourceType' | 'resourceId' | 'serverId'
>;

type HashedDurableTaskIdentity = DurableTaskIdentity & Pick<AgentTaskRecord, 'payloadHash'>;

/**
 * Validate the payload-independent identity of one durable task row. This
 * boundary is mandatory even when an exact never-dispatched failure cannot
 * reconstruct its payload because that payload was itself the rejection cause.
 */
export function validateDurableAgentTaskRowIdentity(
  task: DurableTaskIdentity,
): void {
  if (!Object.prototype.hasOwnProperty.call(AGENT_TASK_RESOURCE_TYPE_BY_KIND, task.kind)) {
    throw new Error(`unknown durable Agent task kind ${String(task.kind)}`);
  }
  zTaskId.parse(task.serverId);
  zTaskId.parse(task.resourceId);
  const expectedResourceType = AGENT_TASK_RESOURCE_TYPE_BY_KIND[task.kind];
  if (task.resourceType !== expectedResourceType) {
    throw new Error(
      `task resourceType ${task.resourceType} does not match ${task.kind} (${expectedResourceType})`,
    );
  }
}

/**
 * Strictly reconstruct one canonical Agent wire payload and bind every payload
 * identity to the durable row. Callers must pass the codec-decoded wire form;
 * RemoteFS secrets are intentionally hashed after decryption, exactly as they
 * were at enqueue and dispatch.
 */
export function parseAndValidateAgentTaskWireIdentity<K extends AgentTaskKind>(
  task: DurableTaskIdentity & { kind: K },
  wireCandidate: unknown,
): AgentTaskPayloadByKind[K] {
  validateDurableAgentTaskRowIdentity(task);

  const payload = jsonValue(
    parseAgentTaskPayload(task.kind, wireCandidate),
  ) as AgentTaskPayloadByKind[K];
  assertAgentTaskWireSize(task.kind, payload);

  switch (task.kind) {
    case AgentTaskKind.ContainerCreate:
    case AgentTaskKind.ContainerStart:
    case AgentTaskKind.ContainerStop:
    case AgentTaskKind.ContainerRestart:
    case AgentTaskKind.ContainerSshEnsure:
      assertSame('payload containerId', task.resourceId, record(payload).containerId);
      break;
    case AgentTaskKind.ContainerDelete:
      assertSame('payload containerId', task.resourceId, record(payload).containerId);
      assertSame('payload serverId', task.serverId, record(payload).serverId);
      break;
    case AgentTaskKind.ContainerRuntimeAbsent:
      assertSame('payload runtimeId', task.resourceId, record(payload).runtimeId);
      assertSame('payload serverId', task.serverId, record(payload).serverId);
      break;
    case AgentTaskKind.DataDirEnsure:
    case AgentTaskKind.DataDirAbsent:
      assertSame('payload resourceId', task.resourceId, record(payload).resourceId);
      break;
    case AgentTaskKind.RemoteFsEnsure:
    case AgentTaskKind.RemoteFsAbsent:
      assertSame('payload id', task.resourceId, record(payload).id);
      break;
    case AgentTaskKind.QuotaEnsure:
      // The logical user id is not part of the wire payload. The finalizer
      // retains the exact QuotaDesired proof against task.resourceId.
      break;
    case AgentTaskKind.ImageEnsurePresent: {
      const imageId = record(payload).imageId;
      if (imageId !== undefined) assertSame('payload imageId', task.resourceId, imageId);
      break;
    }
    case AgentTaskKind.ImageEnsureAbsent:
      assertSame('payload imageId', task.resourceId, record(payload).imageId);
      break;
  }

  return payload;
}

export function validateDurableAgentTaskIdentity<K extends AgentTaskKind>(
  task: HashedDurableTaskIdentity & { kind: K },
  wireCandidate: unknown,
): AgentTaskPayloadByKind[K] {
  const payload = parseAndValidateAgentTaskWireIdentity(task, wireCandidate);
  if (agentTaskPayloadHash(task.kind, payload) !== task.payloadHash) {
    throw new Error('wire payload hash does not match its durable identity');
  }
  return payload;
}

export function agentTaskPayloadHash(kind: AgentTaskKind, payload: unknown): string {
  return createHash('sha256').update(canonicalJson({ kind, payload })).digest('hex');
}

export function assertAgentTaskWireSize(kind: AgentTaskKind, payload: unknown): void {
  const bytes = Buffer.byteLength(canonicalJson({ kind, payload }));
  if (bytes > MAX_AGENT_TASK_WIRE_BYTES) {
    throw new Error(`Agent task wire payload exceeds ${MAX_AGENT_TASK_WIRE_BYTES} bytes`);
  }
}

function assertSame(field: string, expected: string, actual: unknown): void {
  if (actual === expected) return;
  throw new Error(`${field} does not match its durable task identity`);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Agent task payload is not an object');
  }
  return value as Record<string, unknown>;
}

function jsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => jsonValue(entry));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, jsonValue(entry)]),
  );
}
