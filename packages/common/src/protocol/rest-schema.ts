/**
 * Zod schemas for REST request bodies (single source of truth).
 *
 * Response DTOs live in `./rest.ts` as TypeScript interfaces because they are
 * not parsed at runtime on the server side; clients consume them as-is.
 */

import { z } from 'zod';
import { Capability, GpuGrantMode, RemoteFsType, UserStatus } from '../enums.js';
import {
  MAX_AGENT_GPU_DEVICES,
  MAX_GROUP_PRIORITY,
  MAX_PLATFORM_SERVERS,
  MAX_RESOURCE_BYTES,
  MAX_RESOURCE_CPU_MILLIS,
  MAX_SSH_PUBLIC_KEY_TEXT_LENGTH,
} from '../constants.js';
import { normalizeDockerImageRef } from '../utils.js';
import { normalizeOpenSshPublicKey } from './ssh-public-key.js';
import { MAX_CONTAINER_MOUNTS } from '../constants.js';

export const zUserStatus = z.nativeEnum(UserStatus);
const zMutableUserStatus = z.enum([UserStatus.Active, UserStatus.Disabled]);
export const zCapability = z.nativeEnum(Capability);
export const zGpuGrantMode = z.nativeEnum(GpuGrantMode);
export const zExpectedRevision = z.number().int().positive().safe();
export const zConfigSnapshotToken = z.string().length(64).regex(/^[0-9a-f]{64}$/);

const USERNAME_RE = /^[a-z0-9_-]+$/;
const RESOURCE_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const SERVER_SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Canonical opaque identity accepted at REST boundaries.  Entity, Server,
 * disk and mount identifiers are opaque to callers, but must never contain
 * path/query/control syntax or grow without bound.
 */
export const zResourceIdentity = z.string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const zLoginRequest = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(1024),
}).strict();

export const zRefreshTokenRequest = z.object({
  refreshToken: z.string().min(1).max(256),
}).strict();

export const zRotateRefreshTokenRequest = z.object({
  refreshToken: z.string().min(1).max(256),
  requestId: z.string().length(64).regex(/^[0-9a-f]{64}$/),
}).strict();

export const zCreateApiTokenRequest = z.object({
  name: z.string().trim().min(1).max(128),
}).strict();

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export const zCreateUserRequest = z.object({
  username: z.string().min(2).max(64).regex(USERNAME_RE),
  password: z.string().min(8).max(256),
  displayName: z.string().trim().min(1).max(128),
}).strict();

export const zUpdateUserRequest = z.object({
  displayName: z.string().trim().min(1).max(128).optional(),
  password: z.string().min(8).max(256).optional(),
  currentPassword: z.string().max(1024).optional(),
  status: zMutableUserStatus.optional(),
}).strict().refine(
  (value) => value.displayName !== undefined
    || value.password !== undefined
    || value.status !== undefined,
  'At least one mutable user field is required',
);

export const zAddSshKeyRequest = z.object({
  name: z.string().trim().min(1).max(128),
  keyText: z.string().min(1).max(MAX_SSH_PUBLIC_KEY_TEXT_LENGTH).transform((value, ctx) => {
    const normalized = normalizeOpenSshPublicKey(value);
    if (!normalized) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid OpenSSH public key',
      });
      return z.NEVER;
    }
    return normalized;
  }),
}).strict();

// ---------------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------------

export const zCreateServerRequest = z.object({
  name: z.string().trim().min(1).max(128),
  slug: z.string().min(1).max(64).regex(SERVER_SLUG_RE),
}).strict();

export const zUpdateServerRequest = z.object({
  name: z.string().trim().min(1).max(128).optional(),
  slug: z.string().min(1).max(64).regex(SERVER_SLUG_RE).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'At least one server field is required');

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

export const zImageRuntimeOverrides = z.object({
  uid: z.number().int().nonnegative().max(0xffff_fffe),
  entrypoint: z.array(z.string().min(1).max(4096)).max(256).nullable(),
  cmd: z.array(z.string().min(1).max(4096)).max(256).nullable(),
  init: z.boolean(),
}).strict();

export const zDockerImageRef = z.string().min(1).max(512).transform((value, context) => {
  try {
    return normalizeDockerImageRef(value);
  } catch (error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : 'Invalid Docker image reference',
    });
    return z.NEVER;
  }
});

export const zCreateImageRequest = z.object({
  name: z.string().trim().min(1).max(128),
  dockerImage: zDockerImageRef,
  runtimeOverrides: zImageRuntimeOverrides.optional(),
  description: z.string().max(4096).nullable().optional(),
  disableSsh: z.boolean().optional(),
}).strict().transform((value) => ({
  ...value,
  runtimeOverrides: value.runtimeOverrides ?? {
    uid: 0,
    entrypoint: null,
    cmd: null,
    init: false,
  },
})).pipe(z.object({
  name: z.string().trim().min(1).max(128),
  dockerImage: zDockerImageRef,
  runtimeOverrides: zImageRuntimeOverrides,
  description: z.string().max(4096).nullable().optional(),
  disableSsh: z.boolean().optional(),
}).strict());

export const zUpdateImageRequest = z.object({
  name: z.string().trim().min(1).max(128).optional(),
  dockerImage: zDockerImageRef.optional(),
  runtimeOverrides: zImageRuntimeOverrides.optional(),
  description: z.string().max(4096).optional().nullable(),
  isActive: z.boolean().optional(),
  disableSsh: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'At least one image field is required');

/** Administrative image mutation envelope. The revision itself is admission
 * metadata and never counts as a mutable image field. */
export const zUpdateAdminImageRequest = z.object({
  expectedRevision: zExpectedRevision,
  name: z.string().trim().min(1).max(128).optional(),
  dockerImage: zDockerImageRef.optional(),
  runtimeOverrides: zImageRuntimeOverrides.optional(),
  description: z.string().max(4096).optional().nullable(),
  isActive: z.boolean().optional(),
  disableSsh: z.boolean().optional(),
}).strict().refine(
  (value) => Object.keys(value).some((key) => key !== 'expectedRevision'),
  'At least one image field is required',
);

export const zPullImageRequest = z.object({
  serverIds: z.array(z.string().min(1).max(128))
    .min(1)
    .max(MAX_PLATFORM_SERVERS)
    .refine((ids) => new Set(ids).size === ids.length, 'Server IDs must be unique')
    .optional(),
}).strict();

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

export const zContainerPath = z.string().trim().min(1).max(4096).startsWith('/')
  // Repeated separators are canonicalized by the backend. Reject every
  // spelling that canonicalizes to root, not only the literal `/`.
  .refine((value) => value.split('/').some(Boolean), 'Container path must not be root')
  .refine(
    (value) => !value.split('/').some((part) => part === '.' || part === '..'),
    'Container path must not contain dot segments',
  )
  .refine((value) => !/[\0\r\n]/.test(value), 'Container path contains invalid control characters');

export const zContainerMountInput = z.object({
  sourceKind: z.enum(['local', 'remote']),
  sourceId: z.string().trim().min(1).max(128),
  dirName: z.string().min(1).max(64).regex(RESOURCE_NAME_RE),
  containerPath: zContainerPath,
}).strict();

export const zUpdateContainerMountsRequest = z.array(zContainerMountInput)
  .max(MAX_CONTAINER_MOUNTS);

export const zCreateContainerRequest = z.object({
  serverId: z.string().min(1).max(128),
  imageId: z.string().min(1).max(128),
  name: z.string().min(1).max(64).regex(RESOURCE_NAME_RE),
  dataDirs: z
    .array(zContainerMountInput)
    .max(MAX_CONTAINER_MOUNTS)
    .optional(),
}).strict();

export const zExecSessionRequest = z.object({
  shell: z.string().trim().min(1).max(4096).optional(),
  tty: z.boolean().optional(),
  cols: z.number().int().min(1).max(1000).optional(),
  rows: z.number().int().min(1).max(1000).optional(),
}).strict();

// ---------------------------------------------------------------------------
// Data dirs
// ---------------------------------------------------------------------------

export const zDataDirResourceName = z.string().min(1).max(64).regex(RESOURCE_NAME_RE);

export const zCreateDataDirRequest = z.object({
  serverId: z.string().min(1).max(128),
  sourceKind: z.enum(['local', 'remote']),
  sourceId: z.string().min(1).max(128),
  name: zDataDirResourceName,
}).strict();

// ---------------------------------------------------------------------------
// Remote FS Mounts
// ---------------------------------------------------------------------------

const REMOTE_FS_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REMOTE_FS_HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])$/;
const REMOTE_FS_MONITOR_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])(?::([1-9][0-9]{0,4}))?$/;
const REMOTE_FS_PATH_RE = /^\/(?!\.{1,2}(?:\/|$))(?!.*\/\.{1,2}(?:\/|$))[^,\0\r\n]*$/;
const REMOTE_FS_OPTION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:=[A-Za-z0-9][A-Za-z0-9._:/@%+-]*)?$/;
const RESERVED_REMOTE_FS_OPTIONS = new Set([
  'bg',
  'fs',
  'fg',
  'mds_namespace',
  'name',
  'secret',
  'secretfile',
  'vers',
]);
const REMOTE_FS_EXCLUSIVE_OPTION_GROUPS = [
  ['ro', 'rw'],
  ['soft', 'softerr', 'hard'],
  ['sync', 'async'],
  ['atime', 'noatime'],
  ['suid', 'nosuid'],
  ['dev', 'nodev'],
  ['exec', 'noexec'],
  ['lock', 'nolock'],
] as const;

export const zRemoteFsOptions = z.string().max(1024).superRefine((value, ctx) => {
  if (!value) return;
  const parts = value.split(',');
  if (parts.some((part) => !part || part !== part.trim() || !REMOTE_FS_OPTION_RE.test(part))) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Remote FS options must be a comma-separated list of safe option tokens',
    });
    return;
  }
  const keys = new Set<string>();
  for (const part of parts) {
    const key = part.split('=', 1)[0].toLowerCase();
    if (keys.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Remote FS option ${key} must not be repeated`,
      });
    }
    keys.add(key);
    if (RESERVED_REMOTE_FS_OPTIONS.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Remote FS option ${key} is managed by Nyabase`,
      });
    }
  }
  for (const group of REMOTE_FS_EXCLUSIVE_OPTION_GROUPS) {
    const present = group.filter((key) => keys.has(key));
    if (present.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Remote FS options ${present.join(',')} are mutually exclusive`,
      });
    }
  }
});

export const zRemoteFsCreateNfsParams = z.object({
  type: z.literal(RemoteFsType.Nfs),
  nfsServer: z.string().min(1).max(255).regex(REMOTE_FS_HOST_RE),
  exportPath: z.string().min(1).max(4096).regex(REMOTE_FS_PATH_RE),
  version: z.enum(['3', '4', '4.1', '4.2']),
}).strict();

export const zRemoteFsCreateCephFsParams = z.object({
  type: z.literal(RemoteFsType.CephFs),
  monHosts: z.string().min(1).max(2048).superRefine((value, ctx) => {
    const monitors = value.split(',');
    if (monitors.some((monitor) => {
      const match = REMOTE_FS_MONITOR_RE.exec(monitor);
      if (!match) return true;
      const port = match[1];
      return port !== undefined && Number(port) > 65_535;
    })) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'monHosts must contain safe comma-separated host[:port] values with ports from 1 to 65535',
      });
    }
  }),
  fsName: z.string().min(1).max(128).regex(REMOTE_FS_TOKEN_RE).optional(),
  exportPath: z.string().min(1).max(4096).regex(REMOTE_FS_PATH_RE),
  clientName: z.string().min(1).max(128).regex(REMOTE_FS_TOKEN_RE),
  secret: z.string().min(1).max(4096).regex(/^[A-Za-z0-9+/]+={0,2}$/),
}).strict();

export const zRemoteFsCreateParams = z.discriminatedUnion('type', [
  zRemoteFsCreateNfsParams,
  zRemoteFsCreateCephFsParams,
]);

export const zCreateRemoteFsMountRequest = z.object({
  name: z.string().trim().min(1).max(128),
  displayName: z.string().max(128).optional(),
  description: z.string().max(4096).optional(),
  serverIds: z.array(zResourceIdentity).max(1).optional(),
  options: zRemoteFsOptions.optional(),
  params: zRemoteFsCreateParams,
}).strict();

export const zUpdateRemoteFsMountRequest = z.object({
  name: z.string().trim().min(1).max(128).optional(),
  displayName: z.string().max(128).nullable().optional(),
  description: z.string().max(4096).nullable().optional(),
}).strict().refine(
  (value) => Object.keys(value).length > 0,
  'At least one remote FS field is required',
);

// ---------------------------------------------------------------------------
// Groups & grants
// ---------------------------------------------------------------------------

export const zCreateGroupRequest = z.object({
  name: z.string().trim().min(1).max(128),
  description: z.string().max(4096).optional(),
  priority: z.number().int().nonnegative().max(MAX_GROUP_PRIORITY).optional(),
  capabilities: z.array(zCapability)
    .max(Object.values(Capability).length)
    .refine((caps) => new Set(caps).size === caps.length, 'Capabilities must be unique')
    .optional(),
}).strict();

export const zUpdateGroupRequest = z.object({
  name: z.string().trim().min(1).max(128).optional(),
  description: z.string().max(4096).nullable().optional(),
  priority: z.number().int().nonnegative().max(MAX_GROUP_PRIORITY).optional(),
  capabilities: z.array(zCapability)
    .max(Object.values(Capability).length)
    .refine((caps) => new Set(caps).size === caps.length, 'Capabilities must be unique')
    .optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'At least one group field is required');

/** Administrative group metadata mutation envelope. Membership and grant
 * mutations have independent transactional contracts and do not use this CAS. */
export const zUpdateAdminGroupRequest = z.object({
  expectedRevision: zExpectedRevision,
  name: z.string().trim().min(1).max(128).optional(),
  description: z.string().max(4096).nullable().optional(),
  priority: z.number().int().nonnegative().max(MAX_GROUP_PRIORITY).optional(),
  capabilities: z.array(zCapability)
    .max(Object.values(Capability).length)
    .refine((caps) => new Set(caps).size === caps.length, 'Capabilities must be unique')
    .optional(),
}).strict().refine(
  (value) => Object.keys(value).some((key) => key !== 'expectedRevision'),
  'At least one group field is required',
);

const zGrantCpuMillis = z.number().int().nonnegative().max(MAX_RESOURCE_CPU_MILLIS);
const zGrantBytes = z.number().int().nonnegative().max(MAX_RESOURCE_BYTES);
const zGrantGpuIndices = z.array(
  z.number().int().nonnegative().max(MAX_AGENT_GPU_DEVICES - 1),
).max(MAX_AGENT_GPU_DEVICES).refine(
  (indices) => new Set(indices).size === indices.length,
  'GPU indices must be unique',
);

export const zUpsertServerGrantRequest = z.object({
  cpuMillis: zGrantCpuMillis.nullable().optional(),
  memBytes: zGrantBytes.nullable().optional(),
  diskBytes: zGrantBytes.nullable().optional(),
  gpuMode: zGpuGrantMode.nullable().optional(),
  gpuIndices: zGrantGpuIndices.nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
}).strict().superRefine((value, ctx) => {
  if (Object.keys(value).length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'At least one server grant field is required',
    });
    return;
  }
  const modePresent = value.gpuMode !== undefined;
  const indicesPresent = value.gpuIndices !== undefined;
  if (modePresent !== indicesPresent) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: modePresent ? ['gpuIndices'] : ['gpuMode'],
      message: 'GPU mode and indices must be updated together',
    });
    return;
  }
  if (!modePresent) return;

  // A nullable mode retains the historical "all GPUs" meaning. Explicit
  // `none` is required for a CPU-only grant.
  const mode = value.gpuMode ?? GpuGrantMode.All;
  const indices = value.gpuIndices ?? [];
  if (mode === GpuGrantMode.Indices && indices.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['gpuIndices'],
      message: 'GPU indices mode requires at least one index',
    });
  }
  if (mode !== GpuGrantMode.Indices && indices.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['gpuIndices'],
      message: 'GPU indices are only valid in indices mode',
    });
  }
});

export const zAddGroupMemberRequest = z.object({
  userId: z.string().min(1).max(128),
}).strict();

export const zAddImageGrantRequest = z.object({
  imageId: z.string().min(1).max(128),
  serverId: z.string().min(1).max(128),
}).strict();

export const zSyncImageGrantServersRequest = z.object({
  serverIds: z.array(z.string().min(1).max(128))
    .max(MAX_PLATFORM_SERVERS)
    .refine((ids) => new Set(ids).size === ids.length, 'Server IDs must be unique'),
}).strict();

// ---------------------------------------------------------------------------
// System settings
// ---------------------------------------------------------------------------

export const zPatchSystemSettingsRequest = z.object({
  expectedRevision: zExpectedRevision,
  expectedSnapshotToken: zConfigSnapshotToken,
  values: z.record(z.unknown())
    .refine((values) => Object.keys(values).length > 0, 'At least one setting is required')
    .refine(
      (values) => Object.keys(values).length <= 64,
      'At most 64 settings may be updated at once',
    ),
}).strict();

// ---------------------------------------------------------------------------
// Inferred request types
// ---------------------------------------------------------------------------

export type LoginRequest = z.infer<typeof zLoginRequest>;
export type RefreshTokenRequest = z.infer<typeof zRefreshTokenRequest>;
export type RotateRefreshTokenRequest = z.infer<typeof zRotateRefreshTokenRequest>;
export type CreateApiTokenRequest = z.infer<typeof zCreateApiTokenRequest>;
export type CreateUserRequest = z.infer<typeof zCreateUserRequest>;
export type UpdateUserRequest = z.infer<typeof zUpdateUserRequest>;
export type AddSshKeyRequest = z.infer<typeof zAddSshKeyRequest>;
export type CreateServerRequest = z.infer<typeof zCreateServerRequest>;
export type UpdateServerRequest = z.infer<typeof zUpdateServerRequest>;
export type ImageRuntimeOverrides = z.infer<typeof zImageRuntimeOverrides>;
export type CreateImageRequest = z.infer<typeof zCreateImageRequest>;
export type UpdateImageRequest = z.infer<typeof zUpdateImageRequest>;
export type UpdateAdminImageRequest = z.infer<typeof zUpdateAdminImageRequest>;
export type PullImageRequest = z.infer<typeof zPullImageRequest>;
export type CreateContainerRequest = z.infer<typeof zCreateContainerRequest>;
export type UpdateContainerMountsRequest = z.infer<typeof zUpdateContainerMountsRequest>;
export type ExecSessionRequest = z.infer<typeof zExecSessionRequest>;
export type CreateDataDirRequest = z.infer<typeof zCreateDataDirRequest>;
export type RemoteFsCreateParams = z.infer<typeof zRemoteFsCreateParams>;
export type CreateRemoteFsMountRequest = z.infer<typeof zCreateRemoteFsMountRequest>;
export type UpdateRemoteFsMountRequest = z.infer<typeof zUpdateRemoteFsMountRequest>;
export type CreateGroupRequest = z.infer<typeof zCreateGroupRequest>;
export type UpdateGroupRequest = z.infer<typeof zUpdateGroupRequest>;
export type UpdateAdminGroupRequest = z.infer<typeof zUpdateAdminGroupRequest>;
export type UpsertServerGrantRequest = z.infer<typeof zUpsertServerGrantRequest>;
export type AddGroupMemberRequest = z.infer<typeof zAddGroupMemberRequest>;
export type AddImageGrantRequest = z.infer<typeof zAddImageGrantRequest>;
export type SyncImageGrantServersRequest = z.infer<typeof zSyncImageGrantServersRequest>;
export type PatchSystemSettingsRequest = z.infer<typeof zPatchSystemSettingsRequest>;
