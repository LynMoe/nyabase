/**
 * Zod schemas for REST request bodies (single source of truth).
 *
 * Response DTOs live in `./rest.ts` as TypeScript interfaces because they are
 * not parsed at runtime on the server side; clients consume them as-is.
 */

import { z } from 'zod';
import { Capability, GpuGrantMode, RemoteFsType, UserStatus } from '../enums.js';
import { MAX_SSH_PUBLIC_KEY_TEXT_LENGTH } from '../constants.js';
import { normalizeDockerImageRef } from '../utils.js';
import { normalizeOpenSshPublicKey } from './ssh-public-key.js';
import { MAX_CONTAINER_MOUNTS } from '../constants.js';

export const zUserStatus = z.nativeEnum(UserStatus);
const zMutableUserStatus = z.enum([UserStatus.Active, UserStatus.Disabled]);
export const zCapability = z.nativeEnum(Capability);
export const zGpuGrantMode = z.nativeEnum(GpuGrantMode);

const USERNAME_RE = /^[a-z0-9_-]+$/;
const RESOURCE_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const SERVER_SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const zLoginRequest = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export const zRefreshTokenRequest = z.object({
  refreshToken: z.string().min(1),
});

export const zCreateApiTokenRequest = z.object({
  name: z.string().min(1).max(128).trim(),
});

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export const zCreateUserRequest = z.object({
  username: z.string().min(2).max(64).regex(USERNAME_RE),
  password: z.string().min(8),
  displayName: z.string().min(1).max(128),
});

export const zUpdateUserRequest = z.object({
  displayName: z.string().min(1).max(128).optional(),
  password: z.string().min(8).optional(),
  currentPassword: z.string().optional(),
  status: zMutableUserStatus.optional(),
});

export const zAddSshKeyRequest = z.object({
  name: z.string().min(1).max(128),
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
});

// ---------------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------------

export const zCreateServerRequest = z.object({
  name: z.string().min(1).max(128),
  slug: z.string().min(1).max(64).regex(SERVER_SLUG_RE),
}).strict();

export const zUpdateServerRequest = z.object({
  name: z.string().min(1).max(128).optional(),
  slug: z.string().min(1).max(64).regex(SERVER_SLUG_RE).optional(),
}).strict();

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

export const zImageRuntimeOverrides = z.object({
  uid: z.number().int().nonnegative(),
  entrypoint: z.array(z.string().min(1)).nullable(),
  cmd: z.array(z.string().min(1)).nullable(),
  init: z.boolean(),
});

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
  name: z.string().min(1).max(128),
  dockerImage: zDockerImageRef,
  runtimeOverrides: zImageRuntimeOverrides.optional(),
  description: z.string().optional(),
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
  name: z.string().min(1).max(128),
  dockerImage: zDockerImageRef,
  runtimeOverrides: zImageRuntimeOverrides,
  description: z.string().optional(),
  disableSsh: z.boolean().optional(),
}).strict());

export const zUpdateImageRequest = z.object({
  name: z.string().min(1).max(128).optional(),
  dockerImage: zDockerImageRef.optional(),
  runtimeOverrides: zImageRuntimeOverrides.optional(),
  description: z.string().optional().nullable(),
  isActive: z.boolean().optional(),
  disableSsh: z.boolean().optional(),
}).strict();

export const zPullImageRequest = z.object({
  serverIds: z.array(z.string()).optional(),
});

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

export const zCreateContainerRequest = z.object({
  serverId: z.string().min(1).max(128),
  imageId: z.string().min(1).max(128),
  name: z.string().min(1).max(64).regex(RESOURCE_NAME_RE),
  dataDirs: z
    .array(
      z.object({
        sourceKind: z.enum(['local', 'remote']),
        sourceId: z.string().min(1).max(128),
        dirName: z.string().min(1).max(64),
        containerPath: z.string().min(1).max(4096).startsWith('/'),
      }),
    )
    .max(MAX_CONTAINER_MOUNTS)
    .optional(),
}).strict();

export const zExecSessionRequest = z.object({
  shell: z.string().optional(),
  tty: z.boolean().optional(),
  cols: z.number().int().min(1).max(1000).optional(),
  rows: z.number().int().min(1).max(1000).optional(),
});

// ---------------------------------------------------------------------------
// Data dirs
// ---------------------------------------------------------------------------

export const zCreateDataDirRequest = z.object({
  serverId: z.string(),
  sourceKind: z.enum(['local', 'remote']),
  sourceId: z.string(),
  name: z.string().min(1).max(64).regex(RESOURCE_NAME_RE),
});

// ---------------------------------------------------------------------------
// Remote FS Mounts
// ---------------------------------------------------------------------------

const REMOTE_FS_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REMOTE_FS_HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])$/;
const REMOTE_FS_MONITOR_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])(?::[1-9][0-9]{0,4})?$/;
const REMOTE_FS_PATH_RE = /^\/(?!.*(?:^|\/)\.\.?(?:\/|$))[^,\0\r\n]*$/;
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
  for (const part of parts) {
    const key = part.split('=', 1)[0].toLowerCase();
    if (RESERVED_REMOTE_FS_OPTIONS.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Remote FS option ${key} is managed by Nyabase`,
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
    if (monitors.some((monitor) => !REMOTE_FS_MONITOR_RE.test(monitor))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'monHosts must contain safe comma-separated host[:port] values',
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
  name: z.string().min(1).max(128),
  displayName: z.string().max(128).optional(),
  description: z.string().optional(),
  serverIds: z.array(z.string()).optional(),
  options: zRemoteFsOptions.optional(),
  params: zRemoteFsCreateParams,
}).strict();

export const zUpdateRemoteFsMountRequest = z.object({
  name: z.string().min(1).max(128).optional(),
  displayName: z.string().max(128).optional(),
  description: z.string().optional(),
}).strict();

// ---------------------------------------------------------------------------
// Groups & grants
// ---------------------------------------------------------------------------

export const zCreateGroupRequest = z.object({
  name: z.string().min(1).max(128),
  description: z.string().optional(),
  priority: z.number().int().nonnegative().optional(),
  capabilities: z.array(zCapability).optional(),
});

export const zUpdateGroupRequest = z.object({
  name: z.string().min(1).max(128).optional(),
  description: z.string().optional(),
  priority: z.number().int().nonnegative().optional(),
  capabilities: z.array(zCapability).optional(),
});

export const zUpsertServerGrantRequest = z.object({
  cpuMillis: z.number().int().nonnegative().nullable().optional(),
  memBytes: z.number().int().nonnegative().nullable().optional(),
  diskBytes: z.number().int().nonnegative().nullable().optional(),
  gpuMode: zGpuGrantMode.nullable().optional(),
  gpuIndices: z.array(z.number().int().nonnegative()).nullable().optional(),
});

export const zAddGroupMemberRequest = z.object({
  userId: z.string().min(1),
});

export const zAddImageGrantRequest = z.object({
  imageId: z.string().min(1),
  serverId: z.string().min(1),
});

export const zSyncImageGrantServersRequest = z.object({
  serverIds: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// System settings
// ---------------------------------------------------------------------------

export const zPatchSystemSettingsRequest = z.object({
  values: z.record(z.unknown()),
}).strict();

// ---------------------------------------------------------------------------
// Inferred request types
// ---------------------------------------------------------------------------

export type LoginRequest = z.infer<typeof zLoginRequest>;
export type RefreshTokenRequest = z.infer<typeof zRefreshTokenRequest>;
export type CreateApiTokenRequest = z.infer<typeof zCreateApiTokenRequest>;
export type CreateUserRequest = z.infer<typeof zCreateUserRequest>;
export type UpdateUserRequest = z.infer<typeof zUpdateUserRequest>;
export type AddSshKeyRequest = z.infer<typeof zAddSshKeyRequest>;
export type CreateServerRequest = z.infer<typeof zCreateServerRequest>;
export type UpdateServerRequest = z.infer<typeof zUpdateServerRequest>;
export type ImageRuntimeOverrides = z.infer<typeof zImageRuntimeOverrides>;
export type CreateImageRequest = z.infer<typeof zCreateImageRequest>;
export type UpdateImageRequest = z.infer<typeof zUpdateImageRequest>;
export type PullImageRequest = z.infer<typeof zPullImageRequest>;
export type CreateContainerRequest = z.infer<typeof zCreateContainerRequest>;
export type ExecSessionRequest = z.infer<typeof zExecSessionRequest>;
export type CreateDataDirRequest = z.infer<typeof zCreateDataDirRequest>;
export type RemoteFsCreateParams = z.infer<typeof zRemoteFsCreateParams>;
export type CreateRemoteFsMountRequest = z.infer<typeof zCreateRemoteFsMountRequest>;
export type UpdateRemoteFsMountRequest = z.infer<typeof zUpdateRemoteFsMountRequest>;
export type CreateGroupRequest = z.infer<typeof zCreateGroupRequest>;
export type UpdateGroupRequest = z.infer<typeof zUpdateGroupRequest>;
export type UpsertServerGrantRequest = z.infer<typeof zUpsertServerGrantRequest>;
export type AddGroupMemberRequest = z.infer<typeof zAddGroupMemberRequest>;
export type AddImageGrantRequest = z.infer<typeof zAddImageGrantRequest>;
export type SyncImageGrantServersRequest = z.infer<typeof zSyncImageGrantServersRequest>;
export type PatchSystemSettingsRequest = z.infer<typeof zPatchSystemSettingsRequest>;
