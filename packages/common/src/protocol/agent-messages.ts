/**
 * Zod schemas + inferred types for the Agent ↔ Backend WebSocket protocol.
 *
 * Conventions
 * -----------
 * - `z<Name>` is the schema; `<Name>` is the inferred TS type.
 * - All numeric IDs that index into Linux UID/GID/project space must be `.int()`.
 * - Discriminated unions are used wherever a payload has variant shapes.
 */

import { z } from 'zod';
import {
  AgentCommandKind,
  ContainerStatus,
  DockerDaemonState,
  RemoteFsType,
} from '../enums.js';
import { zImageRuntimeOverrides } from './rest-schema.js';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const zContainerStatus = z.nativeEnum(ContainerStatus);
export const zDockerDaemonState = z.nativeEnum(DockerDaemonState);

// ---------------------------------------------------------------------------
// WS envelope
// ---------------------------------------------------------------------------

export const zEnvelope = z.object({
  /** RPC correlation id; absent for one-way events */
  id: z.string().optional(),
  /** Unix epoch ms */
  ts: z.number(),
  kind: z.string(),
  payload: z.unknown(),
});

// ---------------------------------------------------------------------------
// Agent → Backend payloads
// ---------------------------------------------------------------------------

export const zDiskInfo = z.object({
  diskId: z.string(),
  mountPoint: z.string(),
  label: z.string().optional(),
  totalBytes: z.number(),
  usedBytes: z.number(),
  pquotaEnabled: z.boolean(),
});

export const zGpuInfo = z.object({
  index: z.number().int(),
  uuid: z.string(),
  model: z.string(),
  totalMemMiB: z.number(),
});

export const zDataDirMount = z.object({
  diskId: z.string(),
  dirName: z.string(),
  hostPath: z.string(),
  containerPath: z.string(),
});

export const zContainerSpec = z.object({
  runtimeId: z.string(),
  name: z.string(),
  ownerId: z.string(),
  imageId: z.string(),
  cpuMillis: z.number(),
  memBytes: z.number(),
  gpuIndices: z.array(z.number().int()),
  ip: z.string(),
  serverId: z.string(),
  dataDirs: z.array(zDataDirMount),
  createdAt: z.string(),
  specVersion: z.string(),
});

export const zContainerSshServerStatus = z.enum([
  'disabled',
  'container_stopped',
  'running',
  'error',
  'unknown',
]);

export const zContainerSshServerState = z.object({
  enabled: z.boolean(),
  status: zContainerSshServerStatus,
  user: z.literal('root'),
  port: z.literal(22),
  pid: z.number().int().positive().optional(),
  keyHash: z.string().optional(),
  appliedKeyGeneration: z.number().int().nonnegative().optional(),
  hostKeyFingerprint: z.string().optional(),
  lastReconciledAt: z.number().optional(),
  lastError: z.string().optional(),
});

export const zContainerStatsSummary = z.object({
  cpuUsageRatio: z.number(),
  /** Cumulative Docker CPU usage, converted from nanoseconds to microseconds. */
  cpuUsageUsec: z.number().optional(),
  memUsedBytes: z.number(),
  memLimitBytes: z.number(),
  netRxBytes: z.number(),
  netTxBytes: z.number(),
  blockReadBytes: z.number(),
  blockWriteBytes: z.number(),
  gpuMemUsedMiB: z.record(z.number()),
});

export const zContainerSnapshot = z.object({
  spec: zContainerSpec,
  status: zContainerStatus,
  stats: zContainerStatsSummary.nullable(),
  sshServer: zContainerSshServerState,
  labels: z.record(z.string()).optional(),
});

/**
 * NOTE: agent → backend only carries numericUserId (agent has no UUID mapping).
 * Backend resolves UUID via getUserIdsByNumericIds after receiving stateReport.
 */
export const zXfsProjectUsage = z.object({
  numericUserId: z.number().int(),
  projectId: z.number().int(),
  usedBytes: z.number(),
  hardLimitBytes: z.number(),
});

export const zLocalImageInfo = z.object({
  id: z.string(),
  repoTags: z.array(z.string()),
  size: z.number(),
  createdAt: z.number(),
});

export const zDockerResourceLimitStatus = z.object({
  enabled: z.boolean(),
  cgroupParent: z.string().nullable(),
  hostCpuCores: z.number().int().nonnegative(),
  reservedCpuCores: z.number().int().nonnegative(),
  dockerCpuCores: z.number().nullable(),
  cpuQuotaPercent: z.number().nullable(),
  hostMemBytes: z.number().int().nonnegative(),
  reservedMemBytes: z.number().int().nonnegative(),
  memoryHighBytes: z.number().int().nonnegative().nullable(),
  memoryMaxBytes: z.number().int().nonnegative().nullable(),
  sliceUnit: z.string().nullable(),
  sliceFileInSync: z.boolean(),
  unconfinedContainerCount: z.number().int().nonnegative().nullable(),
});

export const zDockerDaemonStatus = z.object({
  serverId: z.string(),
  state: zDockerDaemonState,
  unitFileInSync: z.boolean(),
  enabled: z.boolean(),
  active: z.boolean(),
  pid: z.number().int().nullable(),
  dockerRoot: z.string(),
  socketPath: z.string(),
  serverVersion: z.string().nullable(),
  storageDriver: z.string().nullable(),
  resourceLimit: zDockerResourceLimitStatus.optional(),
  lastError: z.string().nullable(),
  checkedAt: z.number(),
});

export const zHelloPayload = z.object({
  serverId: z.string(),
  hostname: z.string(),
  kernelVersion: z.string(),
  cpuCores: z.number().int(),
  totalMemBytes: z.number(),
  disks: z.array(zDiskInfo),
  gpus: z.array(zGpuInfo),
  macvlanCidr: z.string(),
  macvlanGateway: z.string(),
  macvlanIface: z.string(),
  agentVersion: z.string(),
  localImages: z.array(zLocalImageInfo).default([]),
  dockerRoot: z.string().optional(),
  dockerSocket: z.string().optional(),
});

export const zPullProgressPayload = z.object({
  serverId: z.string(),
  dockerRef: z.string(),
  imageId: z.string().optional(),
  status: z.enum(['pulling', 'done', 'error']),
  progress: z.number(),
  message: z.string(),
  error: z.string().optional(),
});

export const zHeartbeatPayload = z.object({
  serverId: z.string(),
  uptime: z.number(),
});

// ---------------------------------------------------------------------------
// Remote FS params (discriminated union by type)
// ---------------------------------------------------------------------------

export const zNfsParams = z.object({
  type: z.literal(RemoteFsType.Nfs),
  nfsServer: z.string().min(1),
  exportPath: z.string().startsWith('/'),
  version: z.enum(['3', '4', '4.1', '4.2']),
});

export const zCephFsParams = z.object({
  type: z.literal(RemoteFsType.CephFs),
  /** Comma-separated monitor hosts, e.g. "10.0.0.1,10.0.0.2:6789" */
  monHosts: z.string().min(1),
  /** Optional filesystem name for multi-fs clusters */
  fsName: z.string().optional(),
  exportPath: z.string().startsWith('/'),
  /** CephX client name, e.g. "admin" */
  clientName: z.string().min(1),
  /** Base64-encoded CephX secret key (stored in plain text) */
  secret: z.string().min(1),
});

export const zRemoteFsParams = z.discriminatedUnion('type', [zNfsParams, zCephFsParams]);

export const zRemoteFsMountSpec = z.object({
  id: z.string(),
  hostMountPoint: z.string(),
  options: z.string(),
  params: zRemoteFsParams,
});

export const zRemoteFsMountStatus = z.object({
  id: z.string(),
  hostMountPoint: z.string(),
  status: z.enum(['mounted', 'mounting', 'error']),
  error: z.string().optional(),
  lastCheckedAt: z.number(),
  totalBytes: z.number().optional(),
  usedBytes: z.number().optional(),
});

export const zContainerMountSpec = z.object({
  sourceKind: z.enum(['local', 'remote']),
  sourceId: z.string(),
  userId: z.string(),
  dirName: z.string(),
  containerPath: z.string(),
  hostPath: z.string(),
});

export const zDataDiskSpec = z.object({
  diskId: z.string(),
  mountPoint: z.string(),
  label: z.string().optional(),
});

export const zStateReportPayload = z.object({
  serverId: z.string(),
  /** Unix ms timestamp captured before the agent starts collecting this report. */
  observedAt: z.number().int().nonnegative(),
  containers: z.array(zContainerSnapshot),
  xfsProjects: z.array(zXfsProjectUsage),
  disks: z.array(zDiskInfo),
  localImages: z.array(zLocalImageInfo).optional(),
  remoteFsMounts: z.array(zRemoteFsMountStatus).default([]),
  incremental: z.boolean(),
});

export const zMetricPoint = z.object({
  name: z.string(),
  labels: z.record(z.string()),
  value: z.number(),
  ts: z.number(),
});

export const zMetricsBatchPayload = z.object({
  serverId: z.string(),
  points: z.array(zMetricPoint),
});

export const zCommandAckPayload = z.object({
  commandId: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
  data: z.unknown().optional(),
});

export interface AgentCommandEnvelope<K extends AgentCommandKind = AgentCommandKind, P = unknown> {
  operationId: string;
  commandId: string;
  commandKind: K;
  payload: P;
}

export const zAgentCommandEnvelope = z.object({
  operationId: z.string(),
  commandId: z.string(),
  commandKind: z.nativeEnum(AgentCommandKind),
  payload: z.unknown(),
}).superRefine((value, ctx) => {
  if (!Object.prototype.hasOwnProperty.call(value, 'payload')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['payload'],
      message: 'Required',
    });
  }
}).transform((value): AgentCommandEnvelope => value as AgentCommandEnvelope);

export const zOperationProgressPayload = z.object({
  operationId: z.string(),
  commandId: z.string(),
  status: z.enum([
    'accepted',
    'running',
    'waiting_observed',
    'succeeded',
    'failed',
    'not_applicable',
  ]),
  step: z.string(),
  data: z.unknown().optional(),
  error: z.string().optional(),
  ts: z.number(),
});

export const zContainerEventPayload = z.object({
  serverId: z.string(),
  runtimeId: z.string(),
  action: z.string(),
  exitCode: z.number().int().optional(),
});

export const zLogChunkPayload = z.object({
  sessionId: z.string(),
  data: z.string(),
  stderr: z.boolean().optional(),
  eof: z.boolean().optional(),
  exitCode: z.number().int().optional(),
});

export const zDataDirEntry = z.object({
  sourceKind: z.enum(['local', 'remote']),
  sourceId: z.string(),
  name: z.string(),
  hostPath: z.string(),
});

export const zDataDirReportPayload = z.object({
  serverId: z.string(),
  /** Unix ms timestamp captured before the agent starts collecting this report. */
  observedAt: z.number().int().nonnegative(),
  dirs: z.array(zDataDirEntry),
});

// ---------------------------------------------------------------------------
// Backend → Agent command payloads
// ---------------------------------------------------------------------------

export const zStartContainerPayload = z.object({ runtimeId: z.string() });

export const zStopContainerPayload = z.object({
  runtimeId: z.string(),
  timeoutSeconds: z.number().int().nonnegative().optional(),
});

export const zRestartContainerPayload = z.object({
  runtimeId: z.string(),
  timeoutSeconds: z.number().int().nonnegative().optional(),
});

export const zContainerSetPowerPayload = z.object({
  runtimeId: z.string(),
  action: z.enum(['start', 'stop', 'restart']),
  timeoutSeconds: z.number().int().nonnegative().optional(),
  mounts: z.array(zContainerMountSpec).default([]),
});

export const zDeleteContainerPayload = z.object({
  runtimeId: z.string(),
  force: z.boolean().optional(),
});

export const zUpdateUserQuotaPayload = z.object({
  /** Numeric user ID (not UUID) — agent only needs this to call xfs_quota setLimit. */
  numericUserId: z.number().int(),
  diskBytes: z.number().int().nonnegative(),
});

export const zPullImagePayload = z.object({
  dockerRef: z.string(),
  imageId: z.string().optional(),
});

export const zExecStreamPayload = z.object({
  sessionId: z.string(),
  runtimeId: z.string(),
  cmd: z.array(z.string()),
  tty: z.boolean(),
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
  user: z.string().optional(),
});

export const zExecResizePayload = z.object({
  sessionId: z.string(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

export const zExecInputPayload = z.object({
  sessionId: z.string(),
  data: z.string(),
});

export const zExecClosePayload = z.object({ sessionId: z.string() });

export const zCreateDataDirPayload = z.object({
  diskId: z.string(),
  name: z.string(),
  uid: z.number().int().nonnegative(),
  /** Numeric user ID used by agent to set up XFS quota for the new directory. */
  numericUserId: z.number().int(),
});

export const zDeleteDataDirPayload = z.object({
  diskId: z.string(),
  name: z.string(),
});

export const zReconcilePayload = z.object({ serverId: z.string() });

export const zFetchContainerStatsPayload = z.object({ runtimeId: z.string() });

export const zCheckDiskPayload = z.object({ mountPoint: z.string() });

export const zApplyDataDiskPayload = z.object({
  diskId: z.string(),
  mountPoint: z.string(),
  label: z.string().optional(),
});

export const zRemoveDataDiskPayload = z.object({
  diskId: z.string(),
  force: z.boolean().optional(),
});

export const zApplyRemoteFsMountPayload = zRemoteFsMountSpec;

export const zRemoveRemoteFsMountPayload = z.object({
  id: z.string(),
  force: z.boolean().optional(),
});

export const zReconcileContainerMountsPayload = z.object({
  runtimeId: z.string(),
  expected: z.array(zContainerMountSpec),
  toRemove: z.array(z.string()).optional(),
});

export const zApplyContainerMountPayload = z.object({
  runtimeId: z.string(),
  mount: zContainerMountSpec,
});

export const zRemoveContainerMountPayload = z.object({
  runtimeId: z.string(),
  containerPath: z.string(),
});

export const zSelfCheckPayload = z.object({});
export const zReconcileDockerDaemonPayload = z.object({});

export const zReconcileContainerSshPayload = z.object({
  runtimeId: z.string(),
  enabled: z.boolean().default(true),
  internalPublicKey: z.string().optional(),
  internalKeyGeneration: z.number().int().nonnegative().optional(),
  expectedKeyHash: z.string().optional(),
}).superRefine((value, ctx) => {
  if (!value.enabled) return;
  if (!value.internalPublicKey?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['internalPublicKey'],
      message: 'Internal public key is required when SSH is enabled',
    });
  }
  if (value.internalKeyGeneration === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['internalKeyGeneration'],
      message: 'Internal key generation is required when SSH is enabled',
    });
  }
});

export const zSelfCheckItem = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(['ok', 'fail', 'warn']),
  message: z.string(),
});

export const zSelfCheckResult = z.object({
  items: z.array(zSelfCheckItem),
});

export const zCreateContainerPayload = z.object({
  containerId: z.string(),
  specGeneration: z.number().int().positive().default(1),
  ownerId: z.string(),
  /** Numeric owner ID used by agent for XFS quota (path/label still use ownerId UUID). */
  numericOwnerId: z.number().int(),
  imageDockerRef: z.string(),
  imageId: z.string(),
  runtimeOverrides: zImageRuntimeOverrides.default({
    uid: 0,
    entrypoint: null,
    cmd: null,
    init: false,
  }),
  name: z.string(),
  cpuMillis: z.number().int().nonnegative(),
  memBytes: z.number().int().nonnegative(),
  gpuIndices: z.array(z.number().int().nonnegative()).optional(),
  mounts: z.array(zContainerMountSpec).default([]),
  /** Server network config — used by agent to allocate the container IP */
  ipCidr: z.string(),
  gateway: z.string(),
  reservedIps: z.array(z.string()).default([]),
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type DiskInfo = z.infer<typeof zDiskInfo>;
export type GpuInfo = z.infer<typeof zGpuInfo>;
export type DataDirMount = z.infer<typeof zDataDirMount>;
export type ContainerSpec = z.infer<typeof zContainerSpec>;
export type ContainerSshServerStatus = z.infer<typeof zContainerSshServerStatus>;
export type ContainerSshServerState = z.infer<typeof zContainerSshServerState>;
export type ContainerStatsSummary = z.infer<typeof zContainerStatsSummary>;
export type ContainerSnapshot = z.infer<typeof zContainerSnapshot>;
export type XfsProjectUsage = z.infer<typeof zXfsProjectUsage>;
export type LocalImageInfo = z.infer<typeof zLocalImageInfo>;
export type DockerResourceLimitStatus = z.infer<typeof zDockerResourceLimitStatus>;
export type DataDirEntry = z.infer<typeof zDataDirEntry>;
export type NfsParams = z.infer<typeof zNfsParams>;
export type CephFsParams = z.infer<typeof zCephFsParams>;
export type RemoteFsParams = z.infer<typeof zRemoteFsParams>;
export type RemoteFsMountSpec = z.infer<typeof zRemoteFsMountSpec>;
export type RemoteFsMountStatus = z.infer<typeof zRemoteFsMountStatus>;
export type ContainerMountSpec = z.infer<typeof zContainerMountSpec>;
export type DataDiskSpec = z.infer<typeof zDataDiskSpec>;
export type HelloPayload = z.infer<typeof zHelloPayload>;
export type HeartbeatPayload = z.infer<typeof zHeartbeatPayload>;
export type StateReportPayload = z.infer<typeof zStateReportPayload>;
export type MetricPoint = z.infer<typeof zMetricPoint>;
export type MetricsBatchPayload = z.infer<typeof zMetricsBatchPayload>;
export type CommandAckPayload = z.infer<typeof zCommandAckPayload>;
export type OperationProgressPayload = z.infer<typeof zOperationProgressPayload>;
export type ContainerEventPayload = z.infer<typeof zContainerEventPayload>;
export type LogChunkPayload = z.infer<typeof zLogChunkPayload>;
export type DataDirReportPayload = z.infer<typeof zDataDirReportPayload>;
export type PullProgressPayload = z.infer<typeof zPullProgressPayload>;
export type DockerDaemonStatus = z.infer<typeof zDockerDaemonStatus>;

export type CreateContainerPayload = z.infer<typeof zCreateContainerPayload>;
export type StartContainerPayload = z.infer<typeof zStartContainerPayload>;
export type StopContainerPayload = z.infer<typeof zStopContainerPayload>;
export type RestartContainerPayload = z.infer<typeof zRestartContainerPayload>;
export type ContainerSetPowerPayload = z.infer<typeof zContainerSetPowerPayload>;
export type DeleteContainerPayload = z.infer<typeof zDeleteContainerPayload>;
export type UpdateUserQuotaPayload = z.infer<typeof zUpdateUserQuotaPayload>;
export type PullImagePayload = z.infer<typeof zPullImagePayload>;
export type ExecStreamPayload = z.infer<typeof zExecStreamPayload>;
export type ExecResizePayload = z.infer<typeof zExecResizePayload>;
export type ExecInputPayload = z.infer<typeof zExecInputPayload>;
export type ExecClosePayload = z.infer<typeof zExecClosePayload>;
export type CreateDataDirPayload = z.infer<typeof zCreateDataDirPayload>;
export type DeleteDataDirPayload = z.infer<typeof zDeleteDataDirPayload>;
export type ReconcilePayload = z.infer<typeof zReconcilePayload>;
export type FetchContainerStatsPayload = z.infer<typeof zFetchContainerStatsPayload>;
export type CheckDiskPayload = z.infer<typeof zCheckDiskPayload>;
export type ApplyDataDiskPayload = z.infer<typeof zApplyDataDiskPayload>;
export type RemoveDataDiskPayload = z.infer<typeof zRemoveDataDiskPayload>;
export type ApplyRemoteFsMountPayload = z.infer<typeof zApplyRemoteFsMountPayload>;
export type RemoveRemoteFsMountPayload = z.infer<typeof zRemoveRemoteFsMountPayload>;
export type ReconcileContainerMountsPayload = z.infer<typeof zReconcileContainerMountsPayload>;
export type ApplyContainerMountPayload = z.infer<typeof zApplyContainerMountPayload>;
export type RemoveContainerMountPayload = z.infer<typeof zRemoveContainerMountPayload>;
export type SelfCheckPayload = z.infer<typeof zSelfCheckPayload>;
export type ReconcileDockerDaemonPayload = z.infer<typeof zReconcileDockerDaemonPayload>;
export type ReconcileContainerSshPayload = z.infer<typeof zReconcileContainerSshPayload>;
export type SelfCheckItem = z.infer<typeof zSelfCheckItem>;
export type SelfCheckResult = z.infer<typeof zSelfCheckResult>;
