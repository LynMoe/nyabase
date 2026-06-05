/**
 * Zod schemas for REST request bodies (single source of truth).
 *
 * Response DTOs live in `./rest.ts` as TypeScript interfaces because they are
 * not parsed at runtime on the server side; clients consume them as-is.
 */

import { z } from 'zod';
import { Capability, GpuGrantMode, UserStatus } from '../enums.js';
import { normalizeOpenSshPublicKey } from './ssh-public-key.js';

export const zUserStatus = z.nativeEnum(UserStatus);
export const zCapability = z.nativeEnum(Capability);
export const zGpuGrantMode = z.nativeEnum(GpuGrantMode);

const IPV4_CIDR_RE = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/;
const USERNAME_RE = /^[a-z0-9_-]+$/;
const RESOURCE_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

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
  status: zUserStatus.optional(),
});

export const zAddSshKeyRequest = z.object({
  name: z.string().min(1).max(128),
  keyText: z.string().min(1).transform((value, ctx) => {
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
  parentIface: z.string().min(1),
  ipCidr: z.string().regex(IPV4_CIDR_RE),
  gateway: z.string().ip({ version: 'v4' }),
  reservedIps: z.array(z.string().ip({ version: 'v4' })).optional(),
  isGpuServer: z.boolean().optional(),
  defaultCpuMillis: z.number().int().nonnegative().optional(),
  defaultMemBytes: z.number().int().nonnegative().optional(),
  defaultDiskBytes: z.number().int().nonnegative().optional(),
  defaultGpuMode: zGpuGrantMode.optional(),
  defaultGpuIndices: z.array(z.number().int().nonnegative()).optional(),
});

export const zUpdateServerRequest = z.object({
  name: z.string().min(1).max(128).optional(),
  parentIface: z.string().min(1).optional(),
  ipCidr: z.string().regex(IPV4_CIDR_RE).optional(),
  gateway: z.string().ip({ version: 'v4' }).optional(),
  reservedIps: z.array(z.string().ip({ version: 'v4' })).optional(),
  isGpuServer: z.boolean().optional(),
});

export const zUpdateServerDefaultsRequest = z.object({
  defaultCpuMillis: z.number().int().nonnegative().optional(),
  defaultMemBytes: z.number().int().nonnegative().optional(),
  defaultDiskBytes: z.number().int().nonnegative().optional(),
  defaultGpuMode: zGpuGrantMode.optional(),
  defaultGpuIndices: z.array(z.number().int().nonnegative()).optional(),
});

// ---------------------------------------------------------------------------
// Data disks
// ---------------------------------------------------------------------------

export const zAddDataDiskRequest = z.object({
  mountPoint: z.string().startsWith('/'),
  label: z.string().optional(),
});

export const zUpdateDataDiskRequest = z.object({
  /** Display name for the disk; null clears it */
  label: z.union([z.string().max(128), z.null()]),
});

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

export const zImageRuntimeOverrides = z.object({
  uid: z.number().int().nonnegative(),
  entrypoint: z.array(z.string().min(1)).nullable(),
  cmd: z.array(z.string().min(1)).nullable(),
  init: z.boolean(),
});

export const zCreateImageRequest = z.object({
  name: z.string().min(1).max(128),
  dockerImage: z.string().min(1),
  runtimeOverrides: zImageRuntimeOverrides.optional(),
  defaultUid: z.number().int().nonnegative().optional(),
  description: z.string().optional(),
}).transform((value) => ({
  ...value,
  runtimeOverrides: value.runtimeOverrides ?? {
    uid: value.defaultUid ?? 0,
    entrypoint: null,
    cmd: null,
    init: false,
  },
}));

export const zUpdateImageRequest = z.object({
  name: z.string().min(1).max(128).optional(),
  dockerImage: z.string().min(1).optional(),
  runtimeOverrides: zImageRuntimeOverrides.optional(),
  defaultUid: z.number().int().nonnegative().optional(),
  description: z.string().optional().nullable(),
  isActive: z.boolean().optional(),
});

export const zPullImageRequest = z.object({
  serverIds: z.array(z.string()).optional(),
});

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

export const zCreateContainerRequest = z.object({
  serverId: z.string(),
  imageId: z.string(),
  name: z.string().min(1).max(64).regex(RESOURCE_NAME_RE),
  dataDirs: z
    .array(
      z.object({
        sourceKind: z.enum(['local', 'remote']),
        sourceId: z.string(),
        dirName: z.string().min(1).max(64),
        containerPath: z.string().startsWith('/'),
        createIfMissing: z.boolean().optional(),
      }),
    )
    .optional(),
  sshServerEnabled: z.boolean().optional(),
});

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
export type UpdateServerDefaultsRequest = z.infer<typeof zUpdateServerDefaultsRequest>;
export type AddDataDiskRequest = z.infer<typeof zAddDataDiskRequest>;
export type UpdateDataDiskRequest = z.infer<typeof zUpdateDataDiskRequest>;
export type ImageRuntimeOverrides = z.infer<typeof zImageRuntimeOverrides>;
export type CreateImageRequest = z.infer<typeof zCreateImageRequest>;
export type UpdateImageRequest = z.infer<typeof zUpdateImageRequest>;
export type PullImageRequest = z.infer<typeof zPullImageRequest>;
export type CreateContainerRequest = z.infer<typeof zCreateContainerRequest>;
export type ExecSessionRequest = z.infer<typeof zExecSessionRequest>;
export type CreateDataDirRequest = z.infer<typeof zCreateDataDirRequest>;
export type CreateGroupRequest = z.infer<typeof zCreateGroupRequest>;
export type UpdateGroupRequest = z.infer<typeof zUpdateGroupRequest>;
export type UpsertServerGrantRequest = z.infer<typeof zUpsertServerGrantRequest>;
export type AddGroupMemberRequest = z.infer<typeof zAddGroupMemberRequest>;
export type AddImageGrantRequest = z.infer<typeof zAddImageGrantRequest>;
export type SyncImageGrantServersRequest = z.infer<typeof zSyncImageGrantServersRequest>;
