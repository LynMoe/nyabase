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
  AgentTaskKind,
  ContainerStatus,
  DockerDaemonState,
  RemoteFsType,
} from '../enums.js';
import {
  zImageRuntimeOverrides,
  zContainerPath,
  zRemoteFsCreateCephFsParams,
  zRemoteFsCreateNfsParams,
  zRemoteFsOptions,
} from './rest-schema.js';
import {
  MAX_AGENT_DISKS,
  MAX_AGENT_GPU_DEVICES,
  MAX_AGENT_LOCAL_IMAGES,
  MAX_AGENT_MACVLAN_RESERVED_IPS,
  MAX_AGENT_REMOTE_FS_MOUNTS,
  MAX_AGENT_XFS_PROJECTS,
  MAX_CONTAINER_MOUNTS,
  MAX_MANAGED_CONTAINERS_PER_AGENT,
  MAX_MANAGED_DATA_DIRS_PER_AGENT,
  MAX_METRIC_LABEL_KEY_LENGTH,
  MAX_METRIC_LABEL_VALUE_LENGTH,
  MAX_METRIC_LABELS_PER_POINT,
  MAX_METRIC_POINTS_PER_BATCH,
  MAX_RESOURCE_BYTES,
  MAX_RESOURCE_CPU_MILLIS,
  LABEL,
  XFS_PROJECT_ID_MAX,
  XFS_PROJECT_ID_OFFSET,
} from '../constants.js';
import { canonicalIpv4Address } from '../utils.js';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const zServerIdentity = z.string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

const zCanonicalDockerRoot = z.string().min(2).max(4096).startsWith('/').superRefine(
  (value, ctx) => {
    if (/[\0\r\n]/.test(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'dockerRoot contains control characters' });
    }
    const parts = value.split('/');
    if (
      value.endsWith('/')
      || parts.slice(1).some((part) => part === '' || part === '.' || part === '..')
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'dockerRoot must be a canonical absolute path' });
    }
  },
);

export const zContainerStatus = z.nativeEnum(ContainerStatus);
export const zDockerDaemonState = z.nativeEnum(DockerDaemonState);
export const zDataDirName = z.string().min(1).superRefine((name, ctx) => {
  if (name === '.' || name === '..' || /[/\\]/.test(name) || /[\x00-\x1F\x7F]/.test(name)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Invalid data directory name',
    });
  }
});

export const zTaskId = z.string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

/** Maximum timestamp accepted by ECMAScript Date without projection exceptions. */
export const ECMASCRIPT_DATE_MAX_EPOCH_MS = 8_640_000_000_000_000;
/** Agent/Backend clocks may differ, but authoritative observations cannot come from an arbitrary future. */
export const AGENT_PROTOCOL_MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60_000;
export const zSafeEpochMs = z.number()
  .int()
  .nonnegative()
  .max(ECMASCRIPT_DATE_MAX_EPOCH_MS);
export const zAgentObservedEpochMs = zSafeEpochMs.refine(
  (value) => value <= Date.now() + AGENT_PROTOCOL_MAX_FUTURE_CLOCK_SKEW_MS,
  `Timestamp exceeds the ${AGENT_PROTOCOL_MAX_FUTURE_CLOCK_SKEW_MS}ms Agent clock-skew allowance`,
);

// ---------------------------------------------------------------------------
// WS envelope
// ---------------------------------------------------------------------------

export const zEnvelope = z.object({
  /** RPC correlation id; absent for one-way events */
  id: z.string().min(1).max(128).optional(),
  /** Unix epoch ms */
  ts: zAgentObservedEpochMs,
  kind: z.string().min(1).max(128),
  payload: z.unknown(),
}).superRefine((value, ctx) => {
  if (!Object.prototype.hasOwnProperty.call(value, 'payload')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['payload'],
      message: 'Required',
    });
  }
});

// ---------------------------------------------------------------------------
// Agent → Backend payloads
// ---------------------------------------------------------------------------

export const zDiskInfo = z.object({
  diskId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  mountPoint: z.string().min(1).max(4096).startsWith('/').refine(
    (value) => !/[\0\r\n]/.test(value),
    'Disk mountPoint contains invalid control characters',
  ),
  /** Stable filesystem identity (XFS UUID), not a mutable device path. */
  sourceIdentity: z.string().min(1).max(256),
  label: z.string().max(128).optional(),
  totalBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  usedBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  pquotaEnabled: z.boolean(),
}).strict();

export const zGpuInfo = z.object({
  index: z.number().int().nonnegative().max(MAX_AGENT_GPU_DEVICES - 1),
  uuid: z.string().min(1).max(256),
  model: z.string().min(1).max(256),
  totalMemMiB: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();

export const zContainerQuotaPaths = z.array(z.string().min(1).max(4096)).length(2).refine(
  (paths) => new Set(paths).size === paths.length,
  'Container quota recovery paths must be unique',
);

const zCanonicalIpv4Address = z.string().min(7).max(15).refine((value) => {
  try {
    return canonicalIpv4Address(value) === value;
  } catch {
    return false;
  }
}, 'Expected a canonical IPv4 address');

/** Fresh physical runtime evidence; desired product state never crosses this wire. */
export const zContainerRuntimeObservation = z.object({
  runtimeId: z.string().min(1).max(256),
  ip: zCanonicalIpv4Address,
  serverId: zTaskId,
  specGeneration: z.string().max(20).regex(/^[1-9]\d*$/),
  quotaPaths: zContainerQuotaPaths,
}).strict();

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
  lastReconciledAt: zAgentObservedEpochMs.optional(),
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

export const zContainerIdentityLabels = z.object({
  [LABEL.MANAGED]: z.literal('true'),
  [LABEL.CONTAINER_ID]: zTaskId,
  [LABEL.SERVER_ID]: zTaskId,
  [LABEL.SPEC_GENERATION]: z.string().max(20).regex(/^[1-9]\d*$/),
  [LABEL.RUNTIME_SPEC_HASH]: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const zContainerSnapshot = z.object({
  runtime: zContainerRuntimeObservation,
  status: zContainerStatus,
  sshServer: zContainerSshServerState,
  labels: zContainerIdentityLabels,
}).strict();

/**
 * NOTE: agent → backend only carries numericUserId (agent has no UUID mapping).
 * Backend resolves UUID via getUserIdsByNumericIds after receiving stateReport.
 */
const zSafeByteCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const zResourceByteCount = z.number().int().nonnegative().max(MAX_RESOURCE_BYTES);
const zResourceCpuMillis = z.number().int().nonnegative().max(MAX_RESOURCE_CPU_MILLIS);
const zResourceGpuIndices = z.array(
  z.number().int().nonnegative().max(MAX_AGENT_GPU_DEVICES - 1),
).max(MAX_AGENT_GPU_DEVICES).refine(
  (indices) => new Set(indices).size === indices.length,
  'GPU indices must be unique',
);
export const zXfsProjectUsage = z.object({
  numericUserId: z.number()
    .int()
    .positive()
    .max(XFS_PROJECT_ID_MAX - XFS_PROJECT_ID_OFFSET),
  projectId: z.number()
    .int()
    .min(XFS_PROJECT_ID_OFFSET + 1)
    .max(XFS_PROJECT_ID_MAX),
  usedBytes: zSafeByteCount,
  hardLimitBytes: zSafeByteCount,
}).superRefine((usage, ctx) => {
  if (usage.projectId !== usage.numericUserId + XFS_PROJECT_ID_OFFSET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['projectId'],
      message: 'XFS projectId does not match numericUserId',
    });
  }
});

export const zLocalImageInfo = z.object({
  id: z.string().min(1).max(256),
  repoTags: z.array(z.string().min(1).max(4096)).max(128),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();

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
  serverId: zServerIdentity,
  state: zDockerDaemonState,
  unitFileInSync: z.boolean(),
  enabled: z.boolean(),
  active: z.boolean(),
  pid: z.number().int().nullable(),
  dockerRoot: zCanonicalDockerRoot,
  socketPath: z.string(),
  serverVersion: z.string().nullable(),
  storageDriver: z.string().nullable(),
  resourceLimit: zDockerResourceLimitStatus.optional(),
  lastError: z.string().nullable(),
  checkedAt: zAgentObservedEpochMs,
});

export const zHelloPayload = z.object({
  serverId: zServerIdentity,
  hostFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  configFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  hostname: z.string().min(1).max(255).refine((value) => !/[\0\r\n]/.test(value)),
  kernelVersion: z.string().min(1).max(256).refine((value) => !/[\0\r\n]/.test(value)),
  cpuCores: z.number().int().positive().max(1_048_576),
  totalMemBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  disks: z.array(zDiskInfo).max(MAX_AGENT_DISKS),
  gpus: z.array(zGpuInfo).max(MAX_AGENT_GPU_DEVICES),
  macvlanCidr: z.string(),
  macvlanGateway: z.string(),
  macvlanReservedIps: z.array(z.string()).max(MAX_AGENT_MACVLAN_RESERVED_IPS),
  macvlanIface: z.string().min(1).max(64).regex(/^[A-Za-z0-9_.:-]+$/),
  dockerRoot: zCanonicalDockerRoot,
  agentVersion: z.string().min(1).max(128),
  localImages: z.array(zLocalImageInfo).max(MAX_AGENT_LOCAL_IMAGES),
}).strict().superRefine((value, ctx) => {
  const diskIds = value.disks.map((disk) => disk.diskId);
  const diskIdentities = value.disks.map((disk) => disk.sourceIdentity);
  const gpuIndices = value.gpus.map((gpu) => gpu.index);
  const gpuUuids = value.gpus.map((gpu) => gpu.uuid);
  for (const [path, values] of [
    ['disks', diskIds],
    ['disks', diskIdentities],
    ['gpus', gpuIndices],
    ['gpus', gpuUuids],
  ] as const) {
    if (new Set<unknown>(values).size !== values.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [path],
        message: `${path} inventory identities must be unique`,
      });
    }
  }
});

export const zHeartbeatPayload = z.object({
  serverId: zServerIdentity,
  uptime: z.number(),
});

export const zInventoryFaultPayload = z.object({
  serverId: zTaskId,
  code: z.enum([
    'AUTHORITATIVE_INVENTORY_FAILED',
    'AUTHORITATIVE_INVENTORY_TOO_LARGE',
  ]),
  message: z.string().min(1).max(2048),
  observedAt: zAgentObservedEpochMs,
}).strict();

// ---------------------------------------------------------------------------
// Remote FS params (discriminated union by type)
// ---------------------------------------------------------------------------

export const zNfsParams = zRemoteFsCreateNfsParams;

export const zCephFsParams = zRemoteFsCreateCephFsParams;

export const zRemoteFsParams = z.discriminatedUnion('type', [zNfsParams, zCephFsParams]);

/** Stable identity for the remote filesystem itself; excludes credentials and mount options. */
export function remoteFsSourceIdentity(params: z.infer<typeof zRemoteFsParams>): string {
  if (params.type === RemoteFsType.Nfs) {
    return ['remote', 'nfs', params.nfsServer.trim(), params.exportPath].map(encodeURIComponent).join(':');
  }
  const monitors = params.monHosts.split(',').map((value) => value.trim()).filter(Boolean).sort();
  return [
    'remote',
    'cephfs',
    monitors.join(','),
    params.exportPath,
    params.fsName ?? '',
    params.clientName,
  ].map(encodeURIComponent).join(':');
}

export const zRemoteFsMountSpec = z.object({
  id: zTaskId,
  hostMountPoint: z.string().min(1).max(4096),
  options: zRemoteFsOptions,
  params: zRemoteFsParams,
}).strict();

export const zRemoteFsMountStatus = z.object({
  id: zTaskId,
  hostMountPoint: z.string().min(1).max(4096),
  status: z.enum(['mounted', 'mounting', 'error']),
  error: z.string().min(1).max(2048).optional(),
  lastCheckedAt: zAgentObservedEpochMs,
  totalBytes: zSafeByteCount.optional(),
  usedBytes: zSafeByteCount.optional(),
}).strict();

export const zContainerMountSpec = z.object({
  sourceId: z.string().min(1).max(128),
  resourceId: zTaskId,
  sourceIdentity: z.string().min(1).max(4096),
  // Reuse the REST admission boundary at the Agent wire boundary so a corrupt
  // or compromised control-plane sender cannot mount over container root.
  containerPath: zContainerPath,
}).strict();

export const zDataDiskSpec = z.object({
  diskId: z.string(),
  mountPoint: z.string(),
  label: z.string().optional(),
});

export const zDataDirEntry = z.object({
  sourceKind: z.enum(['local', 'remote']),
  sourceId: z.string().min(1).max(256),
  resourceId: zTaskId,
  hostPath: z.string().min(1).max(4096),
}).strict();

const zReconcileProofNonce = z.string().length(64).regex(/^[a-f0-9]{64}$/);

export const zStateReportPayload = z.object({
  serverId: zServerIdentity,
  /** Monotonic within one Agent WebSocket session. */
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  /** Unix ms timestamp captured before the agent starts collecting this report. */
  observedAt: zAgentObservedEpochMs,
  /** One-shot challenge echoed only by the full observation it requested. */
  reconcileProofNonce: zReconcileProofNonce.optional(),
  containers: z.array(zContainerSnapshot).max(MAX_MANAGED_CONTAINERS_PER_AGENT),
  dataDirs: z.array(zDataDirEntry).max(MAX_MANAGED_DATA_DIRS_PER_AGENT),
  xfsProjects: z.array(zXfsProjectUsage).max(MAX_AGENT_XFS_PROJECTS),
  disks: z.array(zDiskInfo).max(MAX_AGENT_DISKS),
  localImages: z.array(zLocalImageInfo).max(MAX_AGENT_LOCAL_IMAGES),
  remoteFsMounts: z.array(zRemoteFsMountStatus).max(MAX_AGENT_REMOTE_FS_MOUNTS),
}).strict().superRefine((value, ctx) => {
  const keys = value.dataDirs.map((entry) =>
    `${entry.sourceKind}\u0000${entry.sourceId}\u0000${entry.resourceId}`);
  if (new Set(keys).size !== keys.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['dataDirs'],
      message: 'Data directory inventory identities must be unique',
    });
  }
  const diskIds = value.disks.map((disk) => disk.diskId);
  const diskIdentities = value.disks.map((disk) => disk.sourceIdentity);
  if (new Set(diskIds).size !== diskIds.length || new Set(diskIdentities).size !== diskIdentities.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['disks'],
      message: 'Disk inventory identities must be unique',
    });
  }
});

export const NYABASE_METRIC_NAMES = [
  'nyabase_container_cpu_usage_ratio',
  'nyabase_container_cpu_usage_usec',
  'nyabase_container_io_read_bytes_total',
  'nyabase_container_io_write_bytes_total',
  'nyabase_container_mem_limit_bytes',
  'nyabase_container_mem_used_bytes',
  'nyabase_container_net_rx_bytes_total',
  'nyabase_container_net_tx_bytes_total',
  'nyabase_disk_total_bytes',
  'nyabase_disk_used_bytes',
  'nyabase_gpu_clock_graphics_mhz',
  'nyabase_gpu_mem_used_bytes',
  'nyabase_gpu_power_watts',
  'nyabase_gpu_proc_mem_used_bytes',
  'nyabase_gpu_temp_celsius',
  'nyabase_gpu_util_ratio',
  'nyabase_host_cpu_usage_ratio',
  'nyabase_host_disk_read_bytes_total',
  'nyabase_host_disk_write_bytes_total',
  'nyabase_host_load1',
  'nyabase_host_load15',
  'nyabase_host_load5',
  'nyabase_host_mem_available_bytes',
  'nyabase_host_mem_total_bytes',
  'nyabase_host_mem_used_bytes',
  'nyabase_host_net_rx_bytes_total',
  'nyabase_host_net_tx_bytes_total',
  'nyabase_user_disk_used_bytes',
] as const;

const NYABASE_METRIC_LABEL_KEYS = new Set([
  'server',
  'container_id',
  'disk_id',
  'gpu_index',
  'user_id',
]);

const HOST_METRIC_NAMES = new Set<string>([
  'nyabase_host_cpu_usage_ratio',
  'nyabase_host_disk_read_bytes_total',
  'nyabase_host_disk_write_bytes_total',
  'nyabase_host_load1',
  'nyabase_host_load15',
  'nyabase_host_load5',
  'nyabase_host_mem_available_bytes',
  'nyabase_host_mem_total_bytes',
  'nyabase_host_mem_used_bytes',
  'nyabase_host_net_rx_bytes_total',
  'nyabase_host_net_tx_bytes_total',
]);
const CONTAINER_METRIC_NAMES = new Set<string>([
  'nyabase_container_cpu_usage_ratio',
  'nyabase_container_cpu_usage_usec',
  'nyabase_container_io_read_bytes_total',
  'nyabase_container_io_write_bytes_total',
  'nyabase_container_mem_limit_bytes',
  'nyabase_container_mem_used_bytes',
  'nyabase_container_net_rx_bytes_total',
  'nyabase_container_net_tx_bytes_total',
]);
const GPU_METRIC_NAMES = new Set<string>([
  'nyabase_gpu_clock_graphics_mhz',
  'nyabase_gpu_mem_used_bytes',
  'nyabase_gpu_power_watts',
  'nyabase_gpu_temp_celsius',
  'nyabase_gpu_util_ratio',
]);

const zMetricLabels = z.record(
  z.string()
    .min(1)
    .max(MAX_METRIC_LABEL_KEY_LENGTH)
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
  z.string().max(MAX_METRIC_LABEL_VALUE_LENGTH),
).superRefine((labels, ctx) => {
  if (Object.keys(labels).length > MAX_METRIC_LABELS_PER_POINT) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Metric point has more than ${MAX_METRIC_LABELS_PER_POINT} labels`,
    });
  }
  if (!labels.server) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Metric point must contain a stable server label',
    });
  }
  for (const key of Object.keys(labels)) {
    if (!NYABASE_METRIC_LABEL_KEYS.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `Metric label "${key}" is not in the bounded label contract`,
      });
      continue;
    }
    const value = labels[key];
    const stableId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
    if (
      (key === 'gpu_index' && !/^(0|[1-9][0-9]{0,5})$/.test(value))
      || (
        key === 'user_id'
        && (
          !/^[1-9][0-9]{0,9}$/.test(value)
          || Number(value) > XFS_PROJECT_ID_MAX - XFS_PROJECT_ID_OFFSET
        )
      )
      || (
        key !== 'gpu_index'
        && key !== 'user_id'
        && !stableId.test(value)
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `Metric label "${key}" must contain a stable bounded identity`,
      });
    }
  }
});

export const zMetricPoint = z.object({
  name: z.enum(NYABASE_METRIC_NAMES),
  labels: zMetricLabels,
  value: z.number().finite(),
  ts: zAgentObservedEpochMs,
}).strict().superRefine((point, ctx) => {
  const required = HOST_METRIC_NAMES.has(point.name)
    ? ['server']
    : CONTAINER_METRIC_NAMES.has(point.name)
      ? ['server', 'container_id']
      : GPU_METRIC_NAMES.has(point.name)
        ? ['server', 'gpu_index']
        : point.name === 'nyabase_gpu_proc_mem_used_bytes'
          ? ['server', 'gpu_index', 'container_id']
          : point.name === 'nyabase_user_disk_used_bytes'
            ? ['server', 'user_id']
            : ['server', 'disk_id'];
  const expected = new Set(required);
  for (const key of Object.keys(point.labels)) {
    if (!expected.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['labels', key],
        message: `Metric ${point.name} does not permit label "${key}"`,
      });
    }
  }
  for (const key of required) {
    if (!point.labels[key]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['labels', key],
        message: `Metric ${point.name} requires label "${key}"`,
      });
    }
  }
});

export const zMetricsBatchPayload = z.object({
  serverId: zServerIdentity,
  points: z.array(zMetricPoint).max(MAX_METRIC_POINTS_PER_BATCH),
}).strict();

export const zCommandAckPayload = z.object({
  commandId: z.string().min(1).max(128),
  ok: z.boolean(),
  error: z.string().min(1).max(2048).optional(),
  data: z.unknown().optional(),
}).strict();

const zTaskOpaqueValue = z.unknown().refine((value) => value !== undefined, {
  message: 'Required',
});

export const zPayloadHash = z.string().regex(/^[a-f0-9]{64}$/, {
  message: 'Expected a lowercase SHA-256 hex digest',
});

export const zTaskExecutePayload = z.object({
  taskId: zTaskId,
  kind: z.nativeEnum(AgentTaskKind),
  payloadHash: zPayloadHash,
  payload: zTaskOpaqueValue,
}).strict();

export const zTaskError = z.object({
  code: z.string().min(1).max(128),
  message: z.string().min(1).max(2048),
  details: z.unknown().optional(),
}).strict();

const zTaskResultIdentity = {
  taskId: zTaskId,
  payloadHash: zPayloadHash,
};

export const zTaskResultPayload = z.discriminatedUnion('status', [
  z.object({
    ...zTaskResultIdentity,
    status: z.literal('succeeded'),
    result: zTaskOpaqueValue,
  }).strict(),
  z.object({
    ...zTaskResultIdentity,
    status: z.literal('failed'),
    error: zTaskError,
    observed: z.record(z.unknown()),
  }).strict(),
  z.object({
    ...zTaskResultIdentity,
    status: z.literal('incomplete'),
    error: zTaskError,
  }).strict(),
]);

export const zTaskAcceptedPayload = z.object({
  taskId: zTaskId,
  payloadHash: zPayloadHash,
}).strict();

export type TaskExecutePayload = z.infer<typeof zTaskExecutePayload>;
export type TaskError = z.infer<typeof zTaskError>;
export type TaskResultPayload = z.infer<typeof zTaskResultPayload>;
export type TaskAcceptedPayload = z.infer<typeof zTaskAcceptedPayload>;

export const zLogChunkPayload = z.object({
  sessionId: z.string(),
  data: z.string().max(2 * 1024 * 1024),
  stderr: z.boolean().optional(),
  eof: z.boolean().optional(),
  exitCode: z.number().int().optional(),
});

// ---------------------------------------------------------------------------
// Backend → Agent direct RPC payloads
// ---------------------------------------------------------------------------

export const zExecStreamPayload = z.object({
  sessionId: z.string().min(1).max(128),
  runtimeId: z.string().min(1).max(256),
  cmd: z.array(z.string().max(8 * 1024)).min(1).max(64),
  tty: z.boolean(),
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
  user: z.string().optional(),
});

export const zExecResizePayload = z.object({
  sessionId: z.string().min(1).max(128),
  cols: z.number().int().positive().max(1_000),
  rows: z.number().int().positive().max(1_000),
});

export const zExecInputPayload = z.object({
  sessionId: z.string().min(1).max(128),
  data: z.string().max(128 * 1024),
});

export const zExecClosePayload = z.object({ sessionId: z.string().min(1).max(128) });

export const zReconcilePayload = z.object({
  serverId: z.string(),
  proofNonce: zReconcileProofNonce.optional(),
}).strict();
export const zAdmissionReadyPayload = z.object({ serverId: z.string() }).strict();

export const zInspectContainerPayload = z.object({
  containerId: zTaskId,
  runtimeId: z.string().min(1).max(256),
}).strict();

export const zInspectContainerResult = z.object({
  runtimeId: z.string().min(1).max(256),
  startedAt: z.string().min(1).max(128),
  running: z.boolean(),
  graphPaths: z.array(z.string().min(1).max(4096)).max(2).refine(
    (paths) => new Set(paths).size === paths.length,
    'Container graph paths must be unique',
  ),
}).strict();

export const zAgentBootstrapPayload = z.object({
  remoteFsMounts: z.array(zRemoteFsMountSpec).max(MAX_AGENT_REMOTE_FS_MOUNTS),
}).strict();

export const zAgentBootstrapResult = z.object({
  remoteFsMounts: z.array(zRemoteFsMountStatus).max(MAX_AGENT_REMOTE_FS_MOUNTS),
}).strict();

export const zSelfCheckPayload = z.object({}).strict();

export const zSelfCheckItem = z.object({
  id: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  label: z.string().min(1).max(256),
  status: z.enum(['ok', 'fail', 'warn']),
  message: z.string().min(1).max(2048),
}).strict();

export const zSelfCheckResult = z.object({
  items: z.array(zSelfCheckItem).max(128),
}).strict();

// ---------------------------------------------------------------------------
// Durable Agent task payloads (selected by AgentTaskKind)
// ---------------------------------------------------------------------------

export const zContainerSshTaskSpec = z.object({
  enabled: z.boolean().default(true),
  internalPublicKey: z.string().optional(),
  internalKeyGeneration: z.number().int().nonnegative().optional(),
  expectedKeyHash: z.string().optional(),
}).strict().superRefine((value, ctx) => {
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

export const zContainerCreateTaskPayload = z.object({
  containerId: zTaskId,
  specGeneration: z.number().int().positive(),
  quotaGeneration: z.number().int().positive(),
  dockerRoot: zCanonicalDockerRoot,
  ownerId: z.string(),
  /** Numeric owner ID used by agent for XFS quota (path/label still use ownerId UUID). */
  numericOwnerId: z.number().int(),
  imageDockerRef: z.string(),
  imageDockerId: z.string().min(1),
  imageId: z.string(),
  assignedIp: z.string().min(7).max(15),
  runtimeOverrides: zImageRuntimeOverrides.default({
    uid: 0,
    entrypoint: null,
    cmd: null,
    init: false,
  }),
  name: z.string(),
  cpuMillis: zResourceCpuMillis,
  memBytes: zResourceByteCount,
  diskBytes: zResourceByteCount,
  gpuIndices: zResourceGpuIndices.optional(),
  mounts: z.array(zContainerMountSpec).max(MAX_CONTAINER_MOUNTS).default([]),
  ssh: zContainerSshTaskSpec.optional(),
}).strict();

export const zContainerStartTaskPayload = z.object({
  containerId: zTaskId,
  runtimeId: z.string().min(1).max(256),
  dockerRoot: zCanonicalDockerRoot,
  quotaGeneration: z.number().int().positive(),
  numericOwnerId: z.number().int(),
  diskBytes: zResourceByteCount,
  quotaPaths: zContainerQuotaPaths,
  mounts: z.array(zContainerMountSpec).max(MAX_CONTAINER_MOUNTS).default([]),
  ssh: zContainerSshTaskSpec.optional(),
}).strict();

export const zContainerStopTaskPayload = z.object({
  containerId: zTaskId,
  runtimeId: z.string().min(1).max(256),
  timeoutSeconds: z.number().int().nonnegative().optional(),
}).strict();

export const zContainerRestartTaskPayload = z.object({
  containerId: zTaskId,
  runtimeId: z.string().min(1).max(256),
  dockerRoot: zCanonicalDockerRoot,
  quotaGeneration: z.number().int().positive(),
  numericOwnerId: z.number().int(),
  diskBytes: zResourceByteCount,
  quotaPaths: zContainerQuotaPaths,
  baselineStartedAt: z.string().min(1),
  timeoutSeconds: z.number().int().nonnegative().optional(),
  mounts: z.array(zContainerMountSpec).max(MAX_CONTAINER_MOUNTS).default([]),
  ssh: zContainerSshTaskSpec.optional(),
}).strict();

export const zContainerDeleteTaskPayload = z.object({
  containerId: zTaskId,
  runtimeId: z.string().min(1).max(256).nullable(),
  serverId: zTaskId,
  specGeneration: z.string().max(20).regex(/^[1-9]\d*$/).nullable(),
  runtimeSpecHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  numericOwnerId: z.number().int(),
  quotaPaths: z.array(z.string().min(1)).max(2).refine(
    (paths) => new Set(paths).size === paths.length,
    'Container quota recovery paths must be unique',
  ),
}).strict().superRefine((value, ctx) => {
  const bound = value.runtimeId !== null;
  if (bound && value.specGeneration !== null && value.runtimeSpecHash !== null && value.quotaPaths.length === 2) {
    return;
  }
  if (!bound && value.specGeneration === null && value.runtimeSpecHash === null && value.quotaPaths.length === 0) {
    return;
  }
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'Bound container deletion requires exact runtime identity and two recovery paths; unbound deletion requires none',
  });
});

/**
 * Exact immutable identity of one unexpected managed Docker runtime.
 * Cleanup is intentionally addressed by runtime id and every discovery label;
 * the Agent must refuse to touch a runtime if any label changed after report.
 */
export const zContainerRuntimeAbsentTaskPayload = z.object({
  runtimeId: z.string().min(1).max(256),
  containerId: zTaskId,
  serverId: zTaskId,
  specGeneration: z.string().max(20).regex(/^[1-9]\d*$/),
  runtimeSpecHash: z.string().regex(/^[a-f0-9]{64}$/),
  quotaPaths: zContainerQuotaPaths,
  observedIp: zCanonicalIpv4Address,
}).strict();

export const zContainerSshEnsureTaskPayload = z.object({
  containerId: zTaskId,
  runtimeId: z.string().min(1).max(256),
  enabled: z.boolean().default(true),
  internalPublicKey: z.string().optional(),
  internalKeyGeneration: z.number().int().nonnegative().optional(),
  expectedKeyHash: z.string().optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.enabled) return;
  if (!value.internalPublicKey?.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['internalPublicKey'], message: 'Internal public key is required when SSH is enabled' });
  }
  if (value.internalKeyGeneration === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['internalKeyGeneration'], message: 'Internal key generation is required when SSH is enabled' });
  }
});

export const zDataDirEnsureTaskPayload = z.object({
  resourceId: zTaskId,
  generation: z.number().int().positive(),
  diskId: z.string(),
  sourceIdentity: z.string().min(1),
  quotaRequired: z.boolean(),
  uid: z.number().int().nonnegative(),
  numericUserId: z.number().int(),
  quotaGeneration: z.number().int().positive(),
  diskBytes: zResourceByteCount,
}).strict();

export const zDataDirAbsentTaskPayload = z.object({
  resourceId: zTaskId,
  generation: z.number().int().positive(),
  diskId: z.string(),
  sourceIdentity: z.string().min(1),
  numericUserId: z.number().int(),
}).strict();

export const zRemoteFsEnsureTaskPayload = zRemoteFsMountSpec.strict();

export const zRemoteFsAbsentTaskPayload = z.object({
  id: z.string(),
  hostMountPoint: z.string(),
  options: z.string(),
  params: zRemoteFsParams,
}).strict();

export const zQuotaEnsureTaskPayload = z.object({
  generation: z.number().int().positive(),
  numericUserId: z.number().int(),
  diskBytes: zResourceByteCount,
}).strict();

export const zImageEnsurePresentTaskPayload = z.object({
  dockerRef: z.string().min(1),
  imageId: z.string().optional(),
}).strict();

export const zImageEnsureAbsentTaskPayload = z.object({
  dockerRef: z.string().min(1),
  imageId: z.string(),
}).strict();

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type DiskInfo = z.infer<typeof zDiskInfo>;
export type GpuInfo = z.infer<typeof zGpuInfo>;
export type DataDirName = z.infer<typeof zDataDirName>;
export type ContainerRuntimeObservation = z.infer<typeof zContainerRuntimeObservation>;
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
export type InventoryFaultPayload = z.infer<typeof zInventoryFaultPayload>;
export type StateReportPayload = z.infer<typeof zStateReportPayload>;
export type MetricPoint = z.infer<typeof zMetricPoint>;
export type MetricsBatchPayload = z.infer<typeof zMetricsBatchPayload>;
export type CommandAckPayload = z.infer<typeof zCommandAckPayload>;
export type LogChunkPayload = z.infer<typeof zLogChunkPayload>;
export type DockerDaemonStatus = z.infer<typeof zDockerDaemonStatus>;

export type ExecStreamPayload = z.infer<typeof zExecStreamPayload>;
export type ExecResizePayload = z.infer<typeof zExecResizePayload>;
export type ExecInputPayload = z.infer<typeof zExecInputPayload>;
export type ExecClosePayload = z.infer<typeof zExecClosePayload>;
export type ReconcilePayload = z.infer<typeof zReconcilePayload>;
export type AdmissionReadyPayload = z.infer<typeof zAdmissionReadyPayload>;
export type InspectContainerPayload = z.infer<typeof zInspectContainerPayload>;
export type InspectContainerResult = z.infer<typeof zInspectContainerResult>;
export type AgentBootstrapPayload = z.infer<typeof zAgentBootstrapPayload>;
export type AgentBootstrapResult = z.infer<typeof zAgentBootstrapResult>;
export type SelfCheckPayload = z.infer<typeof zSelfCheckPayload>;
export type SelfCheckItem = z.infer<typeof zSelfCheckItem>;
export type SelfCheckResult = z.infer<typeof zSelfCheckResult>;

export type ContainerSshTaskSpec = z.infer<typeof zContainerSshTaskSpec>;
export type ContainerCreateTaskPayload = z.infer<typeof zContainerCreateTaskPayload>;
export type ContainerStartTaskPayload = z.infer<typeof zContainerStartTaskPayload>;
export type ContainerStopTaskPayload = z.infer<typeof zContainerStopTaskPayload>;
export type ContainerRestartTaskPayload = z.infer<typeof zContainerRestartTaskPayload>;
export type ContainerDeleteTaskPayload = z.infer<typeof zContainerDeleteTaskPayload>;
export type ContainerRuntimeAbsentTaskPayload = z.infer<typeof zContainerRuntimeAbsentTaskPayload>;
export type ContainerSshEnsureTaskPayload = z.infer<typeof zContainerSshEnsureTaskPayload>;
export type DataDirEnsureTaskPayload = z.infer<typeof zDataDirEnsureTaskPayload>;
export type DataDirAbsentTaskPayload = z.infer<typeof zDataDirAbsentTaskPayload>;
export type RemoteFsEnsureTaskPayload = z.infer<typeof zRemoteFsEnsureTaskPayload>;
export type RemoteFsAbsentTaskPayload = z.infer<typeof zRemoteFsAbsentTaskPayload>;
export type QuotaEnsureTaskPayload = z.infer<typeof zQuotaEnsureTaskPayload>;
export type ImageEnsurePresentTaskPayload = z.infer<typeof zImageEnsurePresentTaskPayload>;
export type ImageEnsureAbsentTaskPayload = z.infer<typeof zImageEnsureAbsentTaskPayload>;

export interface AgentTaskPayloadByKind {
  [AgentTaskKind.ContainerCreate]: ContainerCreateTaskPayload;
  [AgentTaskKind.ContainerStart]: ContainerStartTaskPayload;
  [AgentTaskKind.ContainerStop]: ContainerStopTaskPayload;
  [AgentTaskKind.ContainerRestart]: ContainerRestartTaskPayload;
  [AgentTaskKind.ContainerDelete]: ContainerDeleteTaskPayload;
  [AgentTaskKind.ContainerRuntimeAbsent]: ContainerRuntimeAbsentTaskPayload;
  [AgentTaskKind.ContainerSshEnsure]: ContainerSshEnsureTaskPayload;
  [AgentTaskKind.DataDirEnsure]: DataDirEnsureTaskPayload;
  [AgentTaskKind.DataDirAbsent]: DataDirAbsentTaskPayload;
  [AgentTaskKind.RemoteFsEnsure]: RemoteFsEnsureTaskPayload;
  [AgentTaskKind.RemoteFsAbsent]: RemoteFsAbsentTaskPayload;
  [AgentTaskKind.QuotaEnsure]: QuotaEnsureTaskPayload;
  [AgentTaskKind.ImageEnsurePresent]: ImageEnsurePresentTaskPayload;
  [AgentTaskKind.ImageEnsureAbsent]: ImageEnsureAbsentTaskPayload;
}

export const agentTaskPayloadSchemas = {
  [AgentTaskKind.ContainerCreate]: zContainerCreateTaskPayload,
  [AgentTaskKind.ContainerStart]: zContainerStartTaskPayload,
  [AgentTaskKind.ContainerStop]: zContainerStopTaskPayload,
  [AgentTaskKind.ContainerRestart]: zContainerRestartTaskPayload,
  [AgentTaskKind.ContainerDelete]: zContainerDeleteTaskPayload,
  [AgentTaskKind.ContainerRuntimeAbsent]: zContainerRuntimeAbsentTaskPayload,
  [AgentTaskKind.ContainerSshEnsure]: zContainerSshEnsureTaskPayload,
  [AgentTaskKind.DataDirEnsure]: zDataDirEnsureTaskPayload,
  [AgentTaskKind.DataDirAbsent]: zDataDirAbsentTaskPayload,
  [AgentTaskKind.RemoteFsEnsure]: zRemoteFsEnsureTaskPayload,
  [AgentTaskKind.RemoteFsAbsent]: zRemoteFsAbsentTaskPayload,
  [AgentTaskKind.QuotaEnsure]: zQuotaEnsureTaskPayload,
  [AgentTaskKind.ImageEnsurePresent]: zImageEnsurePresentTaskPayload,
  [AgentTaskKind.ImageEnsureAbsent]: zImageEnsureAbsentTaskPayload,
} satisfies Record<AgentTaskKind, z.ZodTypeAny>;

export function parseAgentTaskPayload<K extends AgentTaskKind>(
  kind: K,
  payload: unknown,
): AgentTaskPayloadByKind[K] {
  return agentTaskPayloadSchemas[kind].parse(payload) as AgentTaskPayloadByKind[K];
}
