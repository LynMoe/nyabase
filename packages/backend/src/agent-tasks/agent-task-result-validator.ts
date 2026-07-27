import { ConflictException } from '@nestjs/common';
import {
  AgentTaskKind,
  normalizeXfsQuotaBytes,
  parseAgentTaskPayload,
  zTaskId,
  type DataDirAbsentTaskPayload,
  type DataDirEnsureTaskPayload,
  type ImageEnsurePresentTaskPayload,
  type TaskResultPayload,
} from '@nyabase/common';
import * as path from 'node:path';
import { z } from 'zod';
import type { AgentTaskRecord } from '../domain/domain-records.js';
import { parseAndValidateAgentTaskWireIdentity } from './agent-task-durable-contract.js';

const zNonEmptyString = z.string().min(1);
const zPhysicalPosixPath = z.string().min(1).max(4096).refine(
  (value) => !/[\0\r\n]/u.test(value),
  'physical POSIX path must not contain NUL, CR, or LF',
);
const PRE_EFFECT_TERMINAL_CODES = new Set([
  'invalid_task_payload',
  'task_payload_hash_mismatch',
  'unsupported_task_kind',
]);
const zContainerResult = z.object({
  containerId: zNonEmptyString,
  runtimeId: zNonEmptyString,
}).passthrough();
const zContainerCreateResult = zContainerResult.extend({
  ip: zNonEmptyString,
  quotaPaths: z.array(zNonEmptyString).length(2),
  runtimeSpecHash: z.string().regex(/^[a-f0-9]{64}$/),
});
const zContainerDeleteResult = z.object({
  containerId: zNonEmptyString,
  runtimeId: z.null(),
  quotaPaths: z.array(zNonEmptyString).max(2).refine(
    (paths) => new Set(paths).size === paths.length,
    'container delete quota paths must be unique',
  ),
}).passthrough();
const zContainerRuntimeAbsentResult = z.object({
  containerId: zNonEmptyString,
  runtimeId: z.null(),
  quotaPaths: z.array(zNonEmptyString).length(2).refine(
    (paths) => new Set(paths).size === paths.length,
    'runtime cleanup quota paths must be unique',
  ),
}).passthrough();
const zDataDirObservation = z.object({
  path: zPhysicalPosixPath,
  exists: z.boolean(),
  isDirectory: z.boolean(),
  uid: z.number().int().nonnegative().nullable(),
  gid: z.number().int().nonnegative().nullable(),
  resourceId: zTaskId.nullable(),
}).passthrough();
const zDataDirResult = zDataDirObservation.extend({
  quotaAssigned: z.boolean(),
}).passthrough();
const zRemoteFsEnsureResult = z.object({
  id: zNonEmptyString,
  hostMountPoint: zNonEmptyString,
}).passthrough();
const zRemoteFsAbsentResult = z.object({ id: zNonEmptyString }).passthrough();
const zQuotaResult = z.object({
  numericUserId: z.number().int(),
  hardLimitBytes: z.number().int().nonnegative(),
}).passthrough();
const zImageResult = z.object({
  imageId: z.string().nullable(),
  dockerId: zNonEmptyString,
  dockerRef: zNonEmptyString,
}).passthrough();
const zImageAbsentResult = z.object({
  imageId: zNonEmptyString,
  dockerId: zNonEmptyString.nullable(),
  dockerRef: zNonEmptyString,
  present: z.literal(false),
}).passthrough();

/**
 * Validates terminal success evidence before it becomes the immutable staged
 * result. Keeping this check in Backend prevents a malformed Agent response
 * from becoming a permanently unfinalizable head-of-line item.
 */
export function validateTerminalAgentResult(
  task: AgentTaskRecord,
  result: Exclude<TaskResultPayload, { status: 'incomplete' }>,
  options: { source?: 'agent' | 'dispatch'; wirePayload?: unknown } = {},
): void {
  try {
    if (Object.prototype.hasOwnProperty.call(options, 'wirePayload')) {
      const payload = parseAndValidateAgentTaskWireIdentity(task, options.wirePayload);
      // All task-kind semantic checks below must interpret exactly the same
      // strict, codec-decoded payload that was bound to the durable row/hash.
      task = { ...task, payloadJson: payload } as AgentTaskRecord;
    } else {
      validateLightweightTaskIdentity(task);
    }
  } catch (error) {
    throw invalidResult(task, error);
  }
  if (result.status === 'failed') {
    validateFailedResult(task, result.error, result.observed, options.source ?? 'agent');
    return;
  }

  try {
    switch (task.kind) {
      case AgentTaskKind.ContainerCreate: {
        const parsed = zContainerCreateResult.parse(result.result);
        assertIdentity('containerId', task.resourceId, parsed.containerId);
        const payload = taskPayload(task);
        if (parsed.ip !== payload.assignedIp) {
          throw invalidResult(task, new Error('container IP does not match the Backend reservation'));
        }
        validateContainerQuotaPaths(task, parsed.quotaPaths);
        return;
      }
      case AgentTaskKind.ContainerStart:
      case AgentTaskKind.ContainerStop:
      case AgentTaskKind.ContainerRestart:
      case AgentTaskKind.ContainerSshEnsure: {
        const parsed = zContainerResult.parse(result.result);
        assertIdentity('containerId', task.resourceId, parsed.containerId);
        const payload = taskPayload(task);
        if (parsed.runtimeId !== payload.runtimeId) {
          throw invalidResult(task, new Error('container runtime does not match the dispatched identity'));
        }
        return;
      }
      case AgentTaskKind.ContainerDelete: {
        const parsed = zContainerDeleteResult.parse(result.result);
        assertIdentity('containerId', task.resourceId, parsed.containerId);
        if (!sameStringArray(parsed.quotaPaths, taskPayload(task).quotaPaths)) {
          throw invalidResult(task, new Error('container delete paths do not match the dispatched evidence'));
        }
        return;
      }
      case AgentTaskKind.ContainerRuntimeAbsent: {
        const parsed = zContainerRuntimeAbsentResult.parse(result.result);
        const payload = taskPayload(task);
        assertIdentity('runtimeId', task.resourceId, stringValue(payload.runtimeId) ?? '');
        assertIdentity('containerId', stringValue(payload.containerId) ?? '', parsed.containerId);
        if (!sameStringArray(parsed.quotaPaths, payload.quotaPaths)) {
          throw invalidResult(task, new Error('runtime cleanup paths do not match the dispatched evidence'));
        }
        return;
      }
      case AgentTaskKind.DataDirEnsure:
      case AgentTaskKind.DataDirAbsent: {
        const parsed = zDataDirResult.parse(result.result);
        validateDataDirPhysicalPath(task, parsed.path);
        if (task.kind === AgentTaskKind.DataDirEnsure) {
          const payload = strictDataDirEnsurePayload(task);
          assertIdentity('resourceId', task.resourceId, parsed.resourceId ?? '');
          if (!parsed.exists || !parsed.isDirectory) {
            throw invalidResult(task, new Error('ensured data directory is not an existing directory'));
          }
          if (parsed.uid !== payload.uid || parsed.gid !== payload.uid) {
            throw invalidResult(
              task,
              new Error('ensured data directory uid/gid do not match the signed request'),
            );
          }
          if (parsed.quotaAssigned !== payload.quotaRequired) {
            throw invalidResult(task, new Error('ensured data directory quota state does not match the signed policy'));
          }
        } else {
          strictDataDirAbsentPayload(task);
          if (
            parsed.exists
            || parsed.isDirectory
            || parsed.uid !== null
            || parsed.gid !== null
            || parsed.resourceId !== null
          ) {
            throw invalidResult(task, new Error('removed data directory still has physical state'));
          }
        }
        return;
      }
      case AgentTaskKind.RemoteFsEnsure: {
        const parsed = zRemoteFsEnsureResult.parse(result.result);
        assertIdentity('id', task.resourceId, parsed.id);
        const payload = taskPayload(task);
        if (parsed.hostMountPoint !== payload.hostMountPoint) {
          throw invalidResult(task, new Error('mounted path does not match the dispatched specification'));
        }
        return;
      }
      case AgentTaskKind.RemoteFsAbsent: {
        const parsed = zRemoteFsAbsentResult.parse(result.result);
        assertIdentity('id', task.resourceId, parsed.id);
        return;
      }
      case AgentTaskKind.QuotaEnsure: {
        const parsed = zQuotaResult.parse(result.result);
        const payload = taskPayload(task);
        if (parsed.numericUserId !== payload.numericUserId) {
          throw invalidResult(task, new Error('quota user does not match the dispatched specification'));
        }
        if (
          typeof payload.diskBytes !== 'number'
          || parsed.hardLimitBytes !== normalizeXfsQuotaBytes(payload.diskBytes)
        ) {
          throw invalidResult(task, new Error('quota hard limit does not match the normalized request'));
        }
        return;
      }
      case AgentTaskKind.ImageEnsurePresent: {
        const parsed = zImageResult.parse(result.result);
        const payload = strictImageEnsurePresentPayload(task);
        if (parsed.dockerRef !== payload.dockerRef) {
          throw invalidResult(task, new Error('image reference does not match the dispatched specification'));
        }
        if (parsed.imageId !== (payload.imageId ?? null)) {
          throw invalidResult(task, new Error('image result identity does not match the signed request'));
        }
        return;
      }
      case AgentTaskKind.ImageEnsureAbsent: {
        const parsed = zImageAbsentResult.parse(result.result);
        const payload = taskPayload(task);
        assertIdentity('imageId', task.resourceId, parsed.imageId);
        if (parsed.dockerRef !== payload.dockerRef) {
          throw invalidResult(task, new Error('removed image reference does not match the dispatched specification'));
        }
        return;
      }
    }
    throw invalidResult(task, new Error(`Unsupported task kind ${String(task.kind)}`));
  } catch (error) {
    if (error instanceof ConflictException) throw error;
    throw invalidResult(task, error);
  }
}

function validateLightweightTaskIdentity(task: AgentTaskRecord): void {
  const payload = record(task.payloadJson);
  if (!payload) return;
  const optionalIdentity = (field: string, expected: string): void => {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      assertIdentity(`payload ${field}`, expected, String(payload[field]));
    }
  };
  switch (task.kind) {
    case AgentTaskKind.ContainerCreate:
    case AgentTaskKind.ContainerStart:
    case AgentTaskKind.ContainerStop:
    case AgentTaskKind.ContainerRestart:
    case AgentTaskKind.ContainerDelete:
    case AgentTaskKind.ContainerSshEnsure:
      optionalIdentity('containerId', task.resourceId);
      break;
    case AgentTaskKind.ContainerRuntimeAbsent:
      optionalIdentity('runtimeId', task.resourceId);
      break;
    case AgentTaskKind.DataDirEnsure:
    case AgentTaskKind.DataDirAbsent:
      optionalIdentity('resourceId', task.resourceId);
      break;
    case AgentTaskKind.RemoteFsEnsure:
    case AgentTaskKind.RemoteFsAbsent:
      optionalIdentity('id', task.resourceId);
      break;
    case AgentTaskKind.ImageEnsurePresent:
      optionalIdentity('imageId', task.resourceId);
      break;
    case AgentTaskKind.ImageEnsureAbsent:
      optionalIdentity('imageId', task.resourceId);
      break;
    case AgentTaskKind.QuotaEnsure:
      break;
  }
}

function validateFailedResult(
  task: AgentTaskRecord,
  error: { code: string },
  observed: Record<string, unknown>,
  source: 'agent' | 'dispatch',
): void {
  try {
    if (observed.applied === false && observed.reason === 'never_dispatched') {
      if (
        source !== 'dispatch'
        || (error.code !== 'DISPATCH_PAYLOAD_INVALID' && error.code !== 'AGENT_TASK_NOT_DISPATCHED')
      ) {
        throw new Error('never-dispatched evidence is valid only for Backend dispatch failure');
      }
      validateNeverDispatchedEvidence(task, observed);
      return;
    }
    if (observed.applied === false && observed.reason === 'invalid_payload') {
      if (PRE_EFFECT_TERMINAL_CODES.has(error.code)) {
        validateInvalidPayloadNoEffectEvidence(observed);
        return;
      }
      throw new Error('invalid-payload no-effect evidence has an unsupported terminal error code');
    }
    const payload = taskPayload(task);
    switch (task.kind) {
      case AgentTaskKind.ContainerCreate: {
        const explicitRollback = record(observed.safetyRollback);
        if (!explicitRollback && observed.applied === false) {
          validateContainerNoEffectEvidence(task, observed);
          return;
        }
        const rollback = explicitRollback ?? observed;
        const containerId = stringValue(rollback.containerId) ?? stringValue(observed.containerId);
        if (containerId !== task.resourceId) {
          throw new Error('container failure evidence does not match the durable container identity');
        }
        // A duplicate/conflicting identity or a proved absent precondition is
        // terminal no-touch evidence. It must never bind or clean a runtime.
        if (rollback.present === false) return;
        if (rollback.running !== false) {
          throw new Error('container create failure has no verified absent/stopped safety barrier');
        }
        if (rollback.serverId !== task.serverId) {
          throw new Error('container create safety barrier was observed on a different server identity');
        }
        validateContainerQuotaPaths(task, observed.quotaPaths);
        return;
      }
      case AgentTaskKind.ContainerStart:
      case AgentTaskKind.ContainerStop:
      case AgentTaskKind.ContainerRestart:
      case AgentTaskKind.ContainerDelete:
      case AgentTaskKind.ContainerSshEnsure: {
        const explicitRollback = record(observed.safetyRollback);
        if (!explicitRollback && observed.applied === false) {
          validateContainerNoEffectEvidence(task, observed);
          return;
        }
        const rollback = explicitRollback ?? observed;
        const containerId = stringValue(rollback.containerId) ?? stringValue(observed.containerId);
        if (containerId !== task.resourceId) {
          throw new Error('container failure evidence does not match the durable container identity');
        }
        // A deterministic precondition failure before a physical mutation is
        // itself a terminal no-effect observation. It must not be retried
        // forever merely because there is no rollback state to prove.
        const absent = rollback.present === false;
        const stopped = rollback.running === false;
        if (!absent && !stopped) {
          throw new Error('container failure has no verified absent/stopped safety barrier');
        }
        validateContainerBarrierRuntimeIdentity(task, payload, rollback, absent);
        if (stopped && rollback.serverId !== task.serverId) {
          throw new Error('container safety barrier was observed on a different server identity');
        }
        return;
      }
      case AgentTaskKind.ContainerRuntimeAbsent: {
        if (observed.applied !== false) {
          throw new Error('runtime cleanup failure is not proved no-touch');
        }
        const runtimeId = stringValue(observed.expectedRuntimeId)
          ?? stringValue(observed.runtimeId);
        const containerId = stringValue(observed.expectedContainerId)
          ?? stringValue(observed.containerId);
        const serverId = stringValue(observed.expectedServerId)
          ?? stringValue(observed.serverId);
        if (
          runtimeId !== stringValue(payload.runtimeId)
          || containerId !== stringValue(payload.containerId)
          || serverId !== stringValue(payload.serverId)
          || stringValue(payload.runtimeId) !== task.resourceId
          || !sameStringArray(observed.expectedQuotaPaths, payload.quotaPaths)
        ) {
          throw new Error('runtime cleanup failure does not match its exact dispatched identity');
        }
        return;
      }
      case AgentTaskKind.DataDirEnsure:
      case AgentTaskKind.DataDirAbsent: {
        const parsed = zDataDirObservation.parse(observed);
        const dataDirPayload = task.kind === AgentTaskKind.DataDirEnsure
          ? strictDataDirEnsurePayload(task)
          : strictDataDirAbsentPayload(task);
        const expected = stringValue(observed.expectedResourceId);
        if (expected !== task.resourceId || dataDirPayload.resourceId !== expected) {
          throw new Error('DataDir failure expected identity does not match the durable resource');
        }
        validateDataDirPhysicalPath(task, parsed.path);
        if (!parsed.exists && (
          parsed.isDirectory
          || parsed.uid !== null
          || parsed.gid !== null
        )) {
          throw new Error('absent DataDir failure observation contains impossible inode state');
        }
        if (parsed.exists && (parsed.uid === null || parsed.gid === null)) {
          throw new Error('present DataDir failure observation lacks uid/gid identity');
        }
        if (Object.prototype.hasOwnProperty.call(observed, 'quotaAssigned')
          && typeof observed.quotaAssigned !== 'boolean') {
          throw new Error('DataDir failure quotaAssigned observation is not boolean');
        }
        if (task.kind === AgentTaskKind.DataDirEnsure) {
          const ensurePayload = dataDirPayload as DataDirEnsureTaskPayload;
          if (
            Object.prototype.hasOwnProperty.call(observed, 'expectedUid')
            && observed.expectedUid !== ensurePayload.uid
          ) {
            throw new Error('DataDir failure expected uid does not match the signed request');
          }
          if (
            Object.prototype.hasOwnProperty.call(observed, 'quotaRequired')
            && observed.quotaRequired !== ensurePayload.quotaRequired
          ) {
            throw new Error('DataDir failure quota policy does not match the signed request');
          }
        }
        return;
      }
      case AgentTaskKind.RemoteFsEnsure:
      case AgentTaskKind.RemoteFsAbsent: {
        if (stringValue(observed.id) !== task.resourceId) {
          throw new Error('RemoteFS failure does not match the durable mount identity');
        }
        if (observed.applied === false && observed.reason === 'running_bind_reference') {
          const desiredPath = stringValue(observed.desiredHostMountPoint)
            ?? stringValue(observed.hostMountPoint);
          if (desiredPath !== stringValue(payload.hostMountPoint)) {
            throw new Error('RemoteFS reference conflict does not match the durable desired path');
          }
          if (
            observed.residualPresent !== true
            || !stringValue(observed.targetPath)
            || !stringValue(observed.runtimeId)
            || !stringValue(observed.sourcePath)
          ) {
            throw new Error('RemoteFS reference conflict lacks exact residual reference evidence');
          }
          return;
        }
        if (stringValue(observed.hostMountPoint) !== stringValue(payload.hostMountPoint)) {
          throw new Error('RemoteFS failure path does not match the durable specification');
        }
        const expectedMounted = task.kind === AgentTaskKind.RemoteFsAbsent;
        if (observed.mounted !== expectedMounted) {
          throw new Error(`RemoteFS failure must verify mounted=${expectedMounted}`);
        }
        return;
      }
      case AgentTaskKind.QuotaEnsure: {
        if (observed.numericUserId !== payload.numericUserId) {
          throw new Error('quota failure does not match the durable user identity');
        }
        if (observed.present !== false && !Number.isSafeInteger(observed.hardLimitBytes)) {
          throw new Error('quota failure has no concrete observed limit');
        }
        return;
      }
      case AgentTaskKind.ImageEnsurePresent: {
        const imagePayload = strictImageEnsurePresentPayload(task);
        if (stringValue(observed.dockerRef) !== imagePayload.dockerRef) {
          throw new Error('image failure does not match the durable image reference');
        }
        if (typeof observed.present !== 'boolean') {
          throw new Error('image failure has no physical presence observation');
        }
        return;
      }
      case AgentTaskKind.ImageEnsureAbsent: {
        if (stringValue(observed.dockerRef) !== stringValue(payload.dockerRef)) {
          throw new Error('image failure does not match the durable image reference');
        }
        if (typeof observed.present !== 'boolean') {
          throw new Error('image failure has no physical presence observation');
        }
        return;
      }
    }
    throw new Error(`Unsupported task kind ${String(task.kind)}`);
  } catch (error) {
    if (error instanceof ConflictException) throw error;
    throw invalidResult(task, error);
  }
}

function validateInvalidPayloadNoEffectEvidence(observed: Record<string, unknown>): void {
  const keys = Object.keys(observed).sort();
  if (
    keys.length !== 2
    || keys[0] !== 'applied'
    || keys[1] !== 'reason'
  ) {
    throw new Error('invalid-payload evidence must be the exact no-effect observation');
  }
}

function validateNeverDispatchedEvidence(
  task: AgentTaskRecord,
  observed: Record<string, unknown>,
): void {
  if (
    Object.prototype.hasOwnProperty.call(observed, 'present')
    || Object.prototype.hasOwnProperty.call(observed, 'running')
    || Object.prototype.hasOwnProperty.call(observed, 'runtimeId')
    || Object.prototype.hasOwnProperty.call(observed, 'safetyRollback')
  ) {
    throw new Error('never-dispatched evidence must not claim physical runtime state');
  }
  let identityField: string;
  switch (task.kind) {
    case AgentTaskKind.ContainerCreate:
    case AgentTaskKind.ContainerStart:
    case AgentTaskKind.ContainerStop:
    case AgentTaskKind.ContainerRestart:
    case AgentTaskKind.ContainerDelete:
    case AgentTaskKind.ContainerSshEnsure:
      identityField = 'containerId';
      break;
    case AgentTaskKind.ContainerRuntimeAbsent:
      identityField = 'expectedRuntimeId';
      break;
    case AgentTaskKind.DataDirEnsure:
    case AgentTaskKind.DataDirAbsent:
      identityField = 'expectedResourceId';
      break;
    case AgentTaskKind.RemoteFsEnsure:
    case AgentTaskKind.RemoteFsAbsent:
      identityField = 'id';
      break;
    case AgentTaskKind.QuotaEnsure:
    case AgentTaskKind.ImageEnsurePresent:
    case AgentTaskKind.ImageEnsureAbsent:
      identityField = 'resourceId';
      break;
  }
  const actualKeys = Object.keys(observed).sort();
  const expectedKeys = ['applied', identityField, 'reason'].sort();
  if (
    actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error('never-dispatched evidence must contain only its exact no-effect identity fields');
  }
  if (
    observed.applied !== false
    || observed.reason !== 'never_dispatched'
    || stringValue(observed[identityField]) !== task.resourceId
  ) {
    throw new Error('never-dispatched evidence does not match its durable task identity');
  }
}

/**
 * `applied:false` is not a magic bypass. It is terminal only when the Agent
 * also supplies one finite, self-contained proof of the unchanged state:
 * absence, duplicate claimants, a conflicting hint, immutable-label drift, or
 * a freshly observed exact runtime state.
 */
function validateContainerNoEffectEvidence(
  task: AgentTaskRecord,
  observed: Record<string, unknown>,
): void {
  const payload = taskPayload(task);
  const physicalContainerId = stringValue(observed.containerId);
  const expectedContainerId = stringValue(observed.expectedContainerId);
  const requestedRuntimeId = stringValue(payload.runtimeId);
  if (expectedContainerId !== null && expectedContainerId !== task.resourceId) {
    throw new Error('container no-effect evidence does not match the durable container identity');
  }

  if (
    observed.present === false
    && physicalContainerId === task.resourceId
    && (requestedRuntimeId === null || stringValue(observed.expectedRuntimeId) === requestedRuntimeId)
  ) return;

  if (Array.isArray(observed.runtimeIds)) {
    const runtimeIds = observed.runtimeIds;
    const runtimes = Array.isArray(observed.runtimes) ? observed.runtimes : [];
    const exactIds = runtimeIds.length > 1
      && runtimeIds.every((runtimeId) => stringValue(runtimeId) !== null)
      && new Set(runtimeIds).size === runtimeIds.length;
    const exactRows = runtimes.length === runtimeIds.length
      && runtimes.every((runtime, index) => stringValue(record(runtime)?.runtimeId) === runtimeIds[index]);
    if (physicalContainerId === task.resourceId && exactIds && exactRows) return;
  }

  const expectedRuntimeId = stringValue(observed.expectedRuntimeId);
  const observedRuntimeId = stringValue(observed.observedRuntimeId);
  if (
    physicalContainerId === task.resourceId
    && requestedRuntimeId !== null
    && expectedRuntimeId === requestedRuntimeId
    && observedRuntimeId !== null
    && observedRuntimeId !== requestedRuntimeId
  ) return;

  const runtimeId = stringValue(observed.runtimeId);
  const runtimeMatches = requestedRuntimeId === null
    ? runtimeId !== null
    : runtimeId === requestedRuntimeId;
  const hasPhysicalLabels = Object.prototype.hasOwnProperty.call(observed, 'containerId')
    && Object.prototype.hasOwnProperty.call(observed, 'serverId')
    && Object.prototype.hasOwnProperty.call(observed, 'managed');
  const labelsDrifted = physicalContainerId !== task.resourceId
    || observed.serverId !== task.serverId
    || observed.managed !== 'true';
  if (expectedContainerId === task.resourceId && runtimeMatches && hasPhysicalLabels && labelsDrifted) return;

  if (
    physicalContainerId === task.resourceId
    && runtimeMatches
    && observed.serverId === task.serverId
    && typeof observed.running === 'boolean'
  ) return;

  throw new Error('container failure has no exact no-effect observation');
}

function validateContainerBarrierRuntimeIdentity(
  task: AgentTaskRecord,
  payload: Record<string, unknown>,
  barrier: Record<string, unknown>,
  absent: boolean,
): void {
  const dispatchedRuntimeId = stringValue(payload.runtimeId);
  const runtimeIdentityRequired = task.kind !== AgentTaskKind.ContainerDelete
    || payload.runtimeId !== null && payload.runtimeId !== undefined;
  if (!runtimeIdentityRequired) return;
  if (!dispatchedRuntimeId) {
    throw new Error('container task has no durable dispatched runtime identity');
  }
  const observedRuntimeId = absent
    ? stringValue(barrier.expectedRuntimeId)
    : stringValue(barrier.runtimeId);
  if (observedRuntimeId !== dispatchedRuntimeId) {
    throw new Error('container failure barrier does not match the dispatched runtime identity');
  }
}

function validateContainerQuotaPaths(task: AgentTaskRecord, value: unknown): string[] {
  const quotaPaths = z.array(zNonEmptyString).length(2).parse(value);
  const payload = taskPayload(task);
  const rawRoot = stringValue(payload.dockerRoot);
  const dockerRoot = rawRoot ? path.resolve(rawRoot) : '';
  if (!dockerRoot || rawRoot !== dockerRoot || new Set(quotaPaths).size !== quotaPaths.length) {
    throw new Error('container quota paths are missing, duplicated, or use an invalid Docker root');
  }
  for (const quotaPath of quotaPaths) {
    const resolved = path.resolve(quotaPath);
    if (
      !path.isAbsolute(quotaPath)
      || resolved !== quotaPath
      || !resolved.startsWith(`${dockerRoot}${path.sep}`)
    ) {
      throw new Error('container quota path is outside the durable Docker root');
    }
  }
  return quotaPaths;
}

function sameStringArray(left: unknown, right: unknown): boolean {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return left.every((value, index) => typeof value === 'string' && value === right[index]);
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function taskPayload(task: AgentTaskRecord): Record<string, unknown> {
  if (!task.payloadJson || typeof task.payloadJson !== 'object' || Array.isArray(task.payloadJson)) {
    throw invalidResult(task, new Error('durable task payload is not an object'));
  }
  return task.payloadJson as Record<string, unknown>;
}

function strictDataDirEnsurePayload(task: AgentTaskRecord): DataDirEnsureTaskPayload {
  const payload = parseAgentTaskPayload(AgentTaskKind.DataDirEnsure, task.payloadJson);
  assertIdentity('payload resourceId', task.resourceId, payload.resourceId);
  return payload;
}

function strictDataDirAbsentPayload(task: AgentTaskRecord): DataDirAbsentTaskPayload {
  const payload = parseAgentTaskPayload(AgentTaskKind.DataDirAbsent, task.payloadJson);
  assertIdentity('payload resourceId', task.resourceId, payload.resourceId);
  return payload;
}

function strictImageEnsurePresentPayload(task: AgentTaskRecord): ImageEnsurePresentTaskPayload {
  const payload = parseAgentTaskPayload(AgentTaskKind.ImageEnsurePresent, task.payloadJson);
  if (payload.imageId !== undefined) {
    assertIdentity('payload imageId', task.resourceId, payload.imageId);
  }
  return payload;
}

function validateDataDirPhysicalPath(task: AgentTaskRecord, value: unknown): string {
  const observedPath = zPhysicalPosixPath.parse(value);
  const resolved = path.posix.normalize(observedPath);
  const suffix = `/${path.posix.join('.nyabase', 'dirs', task.resourceId, 'data')}`;
  if (
    !path.posix.isAbsolute(observedPath)
    || resolved !== observedPath
    || !resolved.endsWith(suffix)
  ) {
    throw new Error(
      `DataDir physical path must end with the exact .nyabase/dirs/${task.resourceId}/data layout`,
    );
  }
  return resolved;
}

function assertIdentity(field: string, expected: string, actual: string): void {
  if (actual === expected) return;
  throw new ConflictException({
    code: 'TASK_RESULT_IDENTITY_CONFLICT',
    message: `Task result ${field} does not match its durable resource identity`,
  });
}

function invalidResult(task: AgentTaskRecord, error: unknown): ConflictException {
  const details = error instanceof Error ? error.message : String(error);
  return new ConflictException({
    code: 'TASK_RESULT_SCHEMA_INVALID',
    message: `Invalid terminal result for ${task.kind}: ${details}`,
    details,
  });
}
