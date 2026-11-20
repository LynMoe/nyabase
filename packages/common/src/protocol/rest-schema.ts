import { z } from 'zod';
import {
  Role,
  ContainerPowerIntent,
  FailureCode,
  IntentKind,
  IntentResourceType,
  IntentStatus,
  NodeMetricsStatus,
  PreflightStatus,
  RootPlacement,
  UserStatus,
} from '../enums.js';
import {
  CONSOLE_DEFAULT_COLS,
  CONSOLE_DEFAULT_ROWS,
  ADMIN_INTENT_LIST_MAX,
  MAX_CONSOLE_COMMAND_ARGUMENT_BYTES,
  MAX_CONSOLE_COMMAND_ARGUMENTS,
  MAX_INTENT_LIST_PAGE_SIZE,
  MAX_PLATFORM_SERVERS,
  MAX_RESOURCE_BYTES,
  MAX_SERVER_LOGICAL_CPU_ID,
  MAX_SSH_PUBLIC_KEY_TEXT_LENGTH,
  MAX_STORAGE_OVERCOMMIT_RATIO,
} from '../constants.js';
import {
  canonicalIpv4Address,
  canonicalIpv4Cidr,
  ipToNum,
  ipv4CidrContains,
  isUsableHostInCidr,
  parseCidr,
} from '../utils.js';
import { normalizeOpenSshPublicKey } from './ssh-public-key.js';
import { CONTAINER_NAME_MAX_LENGTH, CONTAINER_NAME_RE, serverNameProblem } from '../display-name.js';

/** bash as a login shell (it reads ~/.bashrc and the image's prompt); sh where there is no bash. */
const CONSOLE_DEFAULT_COMMAND = ['/bin/sh', '-c', 'command -v bash >/dev/null 2>&1 && exec bash -l; exec sh -l'];
import { MAX_GPU_DEVICES } from '../gpu/pci.js';

const USERNAME_RE = /^[a-z0-9_-]+$/;
const SERVER_SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;
const NETWORK_INTERFACE_RE = /^[A-Za-z0-9_.:-]+$/;
const LOGIN_USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

export const zRole = z.nativeEnum(Role);
export const zExpectedRevision = z.number().int().positive().safe();
export const zResourceIdentity = z.string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const zUuid = z.string().uuid();
export const zPositiveBytes = z.number().int().positive().safe().max(MAX_RESOURCE_BYTES);
export const zIsoDateTime = z.string().datetime({ offset: true });

export const zIpv4Address = z.string().superRefine((value, context) => {
  try {
    ipToNum(value);
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected an IPv4 address' });
  }
}).transform(canonicalIpv4Address);

export const zIpv4Cidr = z.string().superRefine((value, context) => {
  try {
    parseCidr(value);
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected an IPv4 CIDR' });
  }
}).transform(canonicalIpv4Cidr);

const zName = z.string().trim().min(1).max(128);
/** Where a volume mounts inside a container. */
const zContainerPath = z.string().trim().min(2).max(4_096)
  .startsWith('/')
  .refine((value) => value !== '/', 'Container path must not be root')
  .refine((value) => !value.split('/').some((part) => part === '.' || part === '..'),
    'Container path must not contain dot segments')
  .refine((value) => !/[\0\r\n]/.test(value), 'Container path contains invalid control characters')
  .refine((value) => !isForbiddenContainerMountPath(value), 'Container path must not be under /proc, /sys or /dev');
const zContainerName = z.string().min(1).max(CONTAINER_NAME_MAX_LENGTH).regex(CONTAINER_NAME_RE);
const zServerName = z.string().trim().max(128).transform((value) => value.normalize('NFC')).superRefine((value, context) => {
  const problem = serverNameProblem(value);
  if (problem) context.addIssue({ code: z.ZodIssueCode.custom, message: problem });
});
const zServerSlug = z.string().min(1).max(64).regex(SERVER_SLUG_RE);
const zNetworkInterface = z.string().min(1).max(64).regex(NETWORK_INTERFACE_RE);
const zOptionalText = (max: number) => z.string().max(max).nullable().optional();

/** A free-text note: trimmed, and blank (or null) clears it. */
const zOptionalNote = (max: number) => z.string().trim().max(max)
  .transform((value) => (value === '' ? null : value))
  .nullable()
  .optional();

export const MAX_USER_NOTE_LENGTH = 1_000;
export const MAX_SHARED_BACKEND_NOTE_LENGTH = 500;

function assertIpPoolNetworkFields(
  value: {
    cidr: string;
    allocationCidr: string;
    gateway: string;
    reservedIps: string[];
  },
  context: z.RefinementCtx,
): void {
  if (!isUsableHostInCidr(value.cidr, value.gateway)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['gateway'],
      message: 'gateway must be a usable host inside cidr',
    });
  }
  try {
    if (!ipv4CidrContains(value.cidr, value.allocationCidr)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allocationCidr'],
        message: 'allocationCidr must be entirely contained in cidr',
      });
    }
  } catch {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['allocationCidr'],
      message: 'allocationCidr must be a valid IPv4 CIDR contained in cidr',
    });
  }
  const seen = new Set<string>();
  for (const address of value.reservedIps) {
    if (!isUsableHostInCidr(value.cidr, address)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reservedIps'],
        message: 'reservedIps must contain usable hosts inside cidr',
      });
    }
    if (seen.has(address)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reservedIps'],
        message: 'reservedIps must be unique',
      });
    }
    seen.add(address);
  }
}

function assertPatchIpPoolNetworkFields(
  value: {
    cidr?: string;
    allocationCidr?: string;
    gateway?: string;
    reservedIps?: string[];
  },
  context: z.RefinementCtx,
): void {
  if (value.cidr !== undefined && value.gateway !== undefined
    && !isUsableHostInCidr(value.cidr, value.gateway)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['gateway'],
      message: 'gateway must be a usable host inside cidr',
    });
  }
  if (value.cidr !== undefined && value.allocationCidr !== undefined) {
    try {
      if (!ipv4CidrContains(value.cidr, value.allocationCidr)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['allocationCidr'],
          message: 'allocationCidr must be entirely contained in cidr',
        });
      }
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allocationCidr'],
        message: 'allocationCidr must be a valid IPv4 CIDR contained in cidr',
      });
    }
  }
  if (value.cidr !== undefined && value.reservedIps !== undefined) {
    const seen = new Set<string>();
    for (const address of value.reservedIps) {
      if (!isUsableHostInCidr(value.cidr, address) || seen.has(address)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['reservedIps'],
          message: 'reservedIps must be unique usable hosts inside cidr',
        });
      }
      seen.add(address);
    }
  }
}

// Authentication and account management.
export const zLoginRequest = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(1024),
}).strict();

/** The refresh secret is read from the cookie; the body carries only the
 * idempotency key that lets a lost rotation response be recovered. */
export const zRotateRefreshTokenRequest = z.object({
  requestId: z.string().length(64).regex(SHA256_RE),
}).strict();

export const zCreateUserRequest = z.object({
  username: z.string().min(2).max(64).regex(USERNAME_RE),
  password: z.string().min(8).max(256),
  displayName: z.string().trim().min(1).max(128),
  role: zRole.optional(),
  note: zOptionalNote(MAX_USER_NOTE_LENGTH),
}).strict();

export const zUpdateUserRequest = z.object({
  displayName: z.string().trim().min(1).max(128).optional(),
  password: z.string().min(8).max(256).optional(),
  currentPassword: z.string().max(1024).optional(),
  status: z.enum([UserStatus.Active, UserStatus.Disabled]).optional(),
  role: zRole.optional(),
  note: zOptionalNote(MAX_USER_NOTE_LENGTH),
}).strict().refine(
  (value) => value.displayName !== undefined
    || value.password !== undefined
    || value.status !== undefined
    || value.role !== undefined
    || value.note !== undefined,
  'At least one mutable user field is required',
);

export const zAddSshKeyRequest = z.object({
  name: z.string().trim().min(1).max(128),
  keyText: z.string().min(1).max(MAX_SSH_PUBLIC_KEY_TEXT_LENGTH).transform((value, context) => {
    const normalized = normalizeOpenSshPublicKey(value);
    if (!normalized) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid OpenSSH public key' });
      return z.NEVER;
    }
    return normalized;
  }),
  // A key is a lasting credential into every container: minting one needs the
  // password, like an API token, so a leaked short-lived session cannot.
  currentPassword: z.string().min(1).max(1024),
}).strict();

// Server registration, connection, and bootstrap.
export const zServerNetworkFields = z.object({
  parentInterface: zNetworkInterface,
  dnsServers: z.array(zIpv4Address).max(8),
}).strict();

export const zReservedCpus = z.array(z.number().int().min(0).max(MAX_SERVER_LOGICAL_CPU_ID))
  .max(MAX_SERVER_LOGICAL_CPU_ID + 1)
  .refine((cpus) => new Set(cpus).size === cpus.length, 'Reserved CPUs must be unique');

export const zCreateServerRequest = z.object({
  name: zServerName,
  slug: zServerSlug,
  parentInterface: zNetworkInterface,
  dnsServers: z.array(zIpv4Address).max(8),
  reservedCpus: zReservedCpus.default([]),
}).strict();

export const zPatchServerRequest = z.object({
  expectedRevision: zExpectedRevision,
  name: zServerName.optional(),
  slug: zServerSlug.optional(),
  parentInterface: zNetworkInterface.optional(),
  dnsServers: z.array(zIpv4Address).max(8).optional(),
  rootPlacement: z.nativeEnum(RootPlacement).optional(),
  /** Only with random placement; single placement always stores false. */
  rootPlacementSticky: z.boolean().optional(),
  storageOvercommitRatio: z.number().finite()
    .min(1)
    .max(MAX_STORAGE_OVERCOMMIT_RATIO)
    .optional(),
  reservedCpus: zReservedCpus.optional(),
}).strict().refine(
  (value) => Object.keys(value).some((key) => key !== 'expectedRevision'),
  'At least one server field is required',
).refine(
  (value) => !(value.rootPlacement === RootPlacement.Single && value.rootPlacementSticky === true),
  { message: 'Sticky placement needs random placement', path: ['rootPlacementSticky'] },
);

export const zRotateServerEnrollmentRequest = z.object({
  expectedRevision: zExpectedRevision,
}).strict();

export const zRunPreflightRequest = z.object({
  expectedServerRevision: zExpectedRevision,
  poolId: zResourceIdentity,
  probeAddress: zIpv4Address,
}).strict();

// Storage pools, shared backends, volumes, and attachments.
/**
 * Where a disk (a local data pool or a shared backend) mounts in every
 * container of its users. On top of the volume path rules it must not cover a
 * system directory: mounting over /etc or /root would hide the guest's own
 * files in every container at once.
 */
export const zStorageMountPath = zContainerPath
  .transform((value) => `/${value.split('/').filter((part) => part !== '').join('/')}`)
  .refine((value) => !isSystemMountPath(value), 'Mount path must not cover a system directory');

/** System directories a disk mount must not cover (equal to or under). */
export const SYSTEM_MOUNT_ROOTS = [
  '/proc', '/sys', '/dev', '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32',
  '/boot', '/run', '/var',
] as const;
/** Directories a disk mount must not replace outright (mounting below them is fine). */
export const SYSTEM_MOUNT_EXACT = ['/root', '/home', '/tmp', '/opt', '/srv', '/mnt', '/media'] as const;

/** True for a normalized absolute path a disk must not be mounted at. */
export function isSystemMountPath(path: string): boolean {
  return SYSTEM_MOUNT_ROOTS.some((root) => path === root || path.startsWith(`${root}/`))
    || (SYSTEM_MOUNT_EXACT as readonly string[]).includes(path);
}

/** True when two normalized mount paths are equal or one contains the other. */
export function mountPathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export const zStoragePoolSystemDisk = z.object({
  weight: z.number().int().min(1).max(100),
  maxUsedPercent: z.number().int().min(1).max(100).nullable(),
}).strict();

export const zPatchStoragePoolRequest = z.object({
  expectedRevision: zExpectedRevision,
  registered: z.boolean().optional(),
  displayName: zOptionalText(128),
  /** Enables the pool as a data disk mounted here in every container of its users; null disables. */
  mountPath: zStorageMountPath.nullable().optional(),
  /** A disk under maintenance is left out of every container (they start without it). */
  maintenance: z.boolean().optional(),
  /**
   * Turns the system disk role on with these parameters (replacing the old ones), or off with null.
   * Under single placement, turning it on moves the role here from the server's other pool.
   */
  systemDisk: zStoragePoolSystemDisk.nullable().optional(),
}).strict().refine(
  (value) => Object.keys(value).some((key) => key !== 'expectedRevision'),
  'At least one storage pool field is required',
);

/** What enabling a disk at `mountPath` would do now. */
export const zStorageMountPreviewRequest = z.object({
  mountPath: zStorageMountPath,
}).strict();

export const zPatchSharedBackendExecutorRequest = z.object({
  expectedRevision: zExpectedRevision,
  registered: z.boolean(),
}).strict();

export const zDiscoverSharedExecutorsRequest = z.object({
  serverId: zUuid.optional(),
}).strict();

export const zCreateSharedBackendRequest = z.object({
  name: zName,
  displayName: zOptionalText(128),
  identityKey: z.string().trim().min(1).max(512),
  cephFsid: z.string().regex(/^[0-9a-f-]{36}$/i),
  overcommitRatio: z.number().finite().min(1).max(MAX_STORAGE_OVERCOMMIT_RATIO),
  note: zOptionalNote(MAX_SHARED_BACKEND_NOTE_LENGTH),
  /** Where every user's volume on the backend mounts; null = not enabled (no volumes are created). */
  mountPath: zStorageMountPath.nullable().optional(),
}).strict();

export const zPatchSharedBackendRequest = z.object({
  expectedRevision: zExpectedRevision,
  displayName: zOptionalText(128),
  cephFsid: z.string().regex(/^[0-9a-f-]{36}$/i).optional(),
  overcommitRatio: z.number().finite().min(1).max(MAX_STORAGE_OVERCOMMIT_RATIO).optional(),
  note: zOptionalNote(MAX_SHARED_BACKEND_NOTE_LENGTH),
  mountPath: zStorageMountPath.nullable().optional(),
  maintenance: z.boolean().optional(),
}).strict().refine(
  (value) => Object.keys(value).some((key) => key !== 'expectedRevision'),
  'At least one shared backend field is required',
);

export const zCreateIpPoolRequest = z.object({
  name: zName,
  cidr: zIpv4Cidr,
  allocationCidr: zIpv4Cidr,
  gateway: zIpv4Address,
  reservedIps: z.array(zIpv4Address).max(4_096).default([]),
  serverIds: z.array(zResourceIdentity).max(MAX_PLATFORM_SERVERS).default([]),
}).strict().superRefine(assertIpPoolNetworkFields).superRefine((value, context) => {
  if (new Set(value.serverIds).size !== value.serverIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['serverIds'],
      message: 'serverIds must be unique',
    });
  }
});

export const zPatchIpPoolRequest = z.object({
  expectedRevision: zExpectedRevision,
  name: zName.optional(),
  cidr: zIpv4Cidr.optional(),
  allocationCidr: zIpv4Cidr.optional(),
  gateway: zIpv4Address.optional(),
  reservedIps: z.array(zIpv4Address).max(4_096).optional(),
  serverIds: z.array(zResourceIdentity).max(MAX_PLATFORM_SERVERS).optional(),
}).strict().refine(
  (value) => Object.keys(value).some((key) => key !== 'expectedRevision'),
  'At least one IP pool field is required',
).superRefine(assertPatchIpPoolNetworkFields).superRefine((value, context) => {
  if (value.serverIds !== undefined && new Set(value.serverIds).size !== value.serverIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['serverIds'],
      message: 'serverIds must be unique',
    });
  }
});

export const zLocalVolumeScope = z.object({
  kind: z.literal('local'),
  serverId: zResourceIdentity,
  poolId: zResourceIdentity,
}).strict();

export const zSharedVolumeScope = z.object({
  kind: z.literal('shared'),
  sharedBackendId: zResourceIdentity,
}).strict();

export const zVolumeScope = z.discriminatedUnion('kind', [
  zLocalVolumeScope,
  zSharedVolumeScope,
]);

/**
 * Which rows a list endpoint returns: `mine` (default) is the caller's own;
 * `all` is every row and requires the resource's administrator capability.
 */
export const zListScope = z.enum(['mine', 'all']).default('mine');

/**
 * Refinement for list queries: administrator-only filters (the ones that pick
 * other people's or server-wide rows) are refused with 400 unless `scope=all`.
 */
export function onlyWithScopeAll<K extends string>(...keys: readonly K[]) {
  return (value: { scope: 'mine' | 'all' } & Partial<Record<K, unknown>>, ctx: z.RefinementCtx): void => {
    if (value.scope === 'all') return;
    for (const key of keys) {
      if (value[key] === undefined) continue;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${key} is only available with scope=all`,
        path: [key],
      });
    }
  };
}

export const zListSharedVolumesQuery = z.object({
  scope: zListScope,
}).strict();

export const zListVolumesQuery = z.object({
  scope: zListScope,
  serverId: zResourceIdentity.optional(),
}).strict().superRefine(onlyWithScopeAll('serverId'));

export const zListContainersQuery = z.object({
  scope: zListScope,
  serverId: zResourceIdentity.optional(),
});

/**
 * Kernel pseudo-filesystems a tenant-writable volume must never shadow: a
 * volume mounted over /proc (or /sys, /dev) lets the tenant plant files the
 * runtime trusts (CVE-2019-16884 class). The Agent policy and a DB CHECK
 * refuse the same roots.
 */
export const FORBIDDEN_CONTAINER_MOUNT_ROOTS = ['/proc', '/sys', '/dev'] as const;

/** True for a container path equal to or under a forbidden root (repeated slashes and `.` ignored). */
export function isForbiddenContainerMountPath(path: string): boolean {
  const normalized = `/${path.split('/').filter((part) => part !== '' && part !== '.').join('/')}`;
  return FORBIDDEN_CONTAINER_MOUNT_ROOTS.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

// Container desired state and console session requests.
export const zCreateContainerRequest = z.object({
  serverId: zResourceIdentity,
  imageId: zResourceIdentity,
  name: zContainerName,
  rootSizeBytes: zPositiveBytes,
  memBytes: zPositiveBytes,
  /**
   * Requested GPUs by PCI address. Omit when the server has GPU disabled;
   * `[]` opens the NVIDIA runtime without assigning a card. Address-level
   * validation (wildcards, duplicates) happens at admission with GPU_* codes.
   */
  gpuPciAddresses: z.array(z.string()).optional(),
  powerIntent: z.nativeEnum(ContainerPowerIntent),
}).strict();

export const zPatchContainerLimitsRequest = z.object({
  memBytes: zPositiveBytes,
}).strict();

export const zPatchContainerRootSizeRequest = z.object({
  sizeBytes: zPositiveBytes,
}).strict();

export const zPatchContainerNameRequest = z.object({
  name: zContainerName,
}).strict();

export const zCreateExecSessionRequest = z.object({
  command: z.array(z.string().min(1).max(MAX_CONSOLE_COMMAND_ARGUMENT_BYTES))
    .max(MAX_CONSOLE_COMMAND_ARGUMENTS)
    .refine((parts) => parts.every((part) => !part.includes('\0')),
      'Command arguments must not contain NUL')
    .default(CONSOLE_DEFAULT_COMMAND),
  tty: z.boolean().default(true),
  cols: z.number().int().min(1).max(1_000).default(CONSOLE_DEFAULT_COLS),
  rows: z.number().int().min(1).max(1_000).default(CONSOLE_DEFAULT_ROWS),
}).strict();

export const zEmptyRequest = z.object({}).strict();

// Images and per-server image assignments.
const SIMPLESTREAMS_ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;

export const zAddCatalogImageRequest = z.object({
  alias: z.string().trim().min(1).max(256).regex(SIMPLESTREAMS_ALIAS_RE),
}).strict();

export const zCreateImageRequest = z.object({
  alias: z.string().trim().min(1).max(256).regex(SIMPLESTREAMS_ALIAS_RE),
  description: z.string().max(4_096).nullable().optional(),
  loginUser: z.string().regex(LOGIN_USER_RE),
  minRootSizeBytes: zPositiveBytes.nullable().optional(),
  networkManagedExternally: z.boolean(),
}).strict();

export const zPatchImageRequest = z.object({
  expectedRevision: zExpectedRevision,
  description: z.string().max(4_096).nullable().optional(),
  minRootSizeBytes: zPositiveBytes.nullable().optional(),
  networkManagedExternally: z.boolean().optional(),
  isActive: z.boolean().optional(),
}).strict().refine(
  (value) => Object.keys(value).some((key) => key !== 'expectedRevision'),
  'At least one image field is required',
);

export const zPutImageAssignmentRequest = z.object({
  expectedRevision: zExpectedRevision.optional(),
}).strict();

// Grant mutations use complete canonical bodies and PCI identity.
// Quotas: null = unlimited; a number is a positive limit (0 is not a sentinel).
const zNullableBytes = zPositiveBytes.nullable();

const zGrantCpuCores = z.number().int().min(1).max(MAX_SERVER_LOGICAL_CPU_ID + 1).nullable();
/** GPUs picked from the server's cards; null = every card, 0 = none. */
const zGrantGpuCount = z.number().int().min(0).max(MAX_GPU_DEVICES).nullable();

/** The server quotas a bundle defines and a server grant may override. */
export const zGrantBundleQuotas = z.object({
  /** Whole logical CPUs pinned for the user on this server; null = every unreserved CPU. */
  cpuCores: zGrantCpuCores,
  memBytes: zNullableBytes,
  /** Sum of the user's system disks on the server. */
  rootDiskBytes: zNullableBytes,
  gpuCount: zGrantGpuCount,
}).strict();

export const zGrantBundleName = z.string().trim().min(1).max(64);

export const zCreateGrantBundleRequest = zGrantBundleQuotas.extend({
  serverId: zResourceIdentity,
  name: zGrantBundleName,
}).strict();

/** Proposed bundle changes; the preview shows which grants follow them. */
export const zPreviewGrantBundleRequest = zGrantBundleQuotas.partial().extend({
  name: zGrantBundleName.optional(),
}).strict();

export const zPatchGrantBundleRequest = zPreviewGrantBundleRequest.extend({
  expectedRevision: zExpectedRevision,
}).strict().refine(
  (value) => Object.keys(value).some((key) => key !== 'expectedRevision'),
  'At least one bundle field is required',
);

/** A key present overrides that bundle field for this user (null = unlimited); an absent key follows the bundle. */
export const zServerGrantOverrides = zGrantBundleQuotas.partial();

export const zPutServerGrantRequest = z.object({
  bundleId: zResourceIdentity,
  overrides: zServerGrantOverrides.default({}),
  expiresAt: zIsoDateTime.nullable().default(null),
  /** Required to replace the user's existing grant on the server; without it that is a 409. */
  replace: z.boolean().default(false),
}).strict();

export const zPatchServerGrantRequest = z.object({
  /** The complete set of overrides; fields left out follow the bundle again. */
  overrides: zServerGrantOverrides.optional(),
  expiresAt: zIsoDateTime.nullable().optional(),
}).strict().refine(
  (value) => value.overrides !== undefined || value.expiresAt !== undefined,
  'At least one grant field is required',
);

/** Data disks of one server the user holds a grant for, sharing one quota. */
const zDataDiskPoolIds = z.array(zResourceIdentity).min(1).max(64)
  .refine((ids) => new Set(ids).size === ids.length, 'Data disks must not repeat');

export const zCreateDataDiskGrantRequest = z.object({
  serverId: zResourceIdentity,
  poolIds: zDataDiskPoolIds,
  limitBytes: zPositiveBytes,
  /** Take disks that belong to another data-disk grant of the user out of it. */
  movePools: z.boolean().optional(),
}).strict();

export const zPatchDataDiskGrantRequest = z.object({
  limitBytes: zPositiveBytes.optional(),
  /** The complete new set of disks: disks left out are revoked unless another grant takes them. */
  poolIds: zDataDiskPoolIds.optional(),
  movePools: z.boolean().optional(),
}).strict().refine(
  (value) => value.limitBytes !== undefined || value.poolIds !== undefined,
  'At least one data-disk grant field is required',
);

export const zPutSharedBackendGrantRequest = z.object({
  limitBytes: zPositiveBytes,
  expiresAt: zIsoDateTime.nullable(),
}).strict();

// Intents, errors, and preflight reports.
export const zIntentListQuery = z.object({
  scope: zListScope,
  limit: z.coerce.number().int().min(1).max(ADMIN_INTENT_LIST_MAX).optional(),
  cursor: z.string().min(1).max(512).optional(),
  status: z.nativeEnum(IntentStatus).optional(),
  kind: z.nativeEnum(IntentKind).optional(),
  resourceType: z.nativeEnum(IntentResourceType).optional(),
  /** One resource id, or several separated by commas (e.g. every assignment of an image). */
  resourceId: z.string().max(4_096)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*(,[A-Za-z0-9][A-Za-z0-9._:-]*)*$/)
    .optional(),
  serverId: zResourceIdentity.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.scope === 'mine' && value.limit !== undefined && value.limit > MAX_INTENT_LIST_PAGE_SIZE) {
    ctx.addIssue({
      code: 'too_big',
      origin: 'number',
      maximum: MAX_INTENT_LIST_PAGE_SIZE,
      inclusive: true,
      input: value.limit,
      path: ['limit'],
    });
  }
});

export const zRetryIntentRequest = zEmptyRequest;

export const zNodeMetricsHealth = z.object({
  status: z.nativeEnum(NodeMetricsStatus),
  lastSuccessAt: zIsoDateTime.nullable(),
  outageSince: zIsoDateTime.nullable(),
  lastError: z.string().max(4_096).nullable(),
}).strict();
export const zIntentAcceptedDto = z.object({
  intentId: zResourceIdentity,
  resourceType: z.nativeEnum(IntentResourceType),
  resourceId: zResourceIdentity,
  serverId: zResourceIdentity.nullable(),
  targetRevision: zExpectedRevision,
  status: z.literal(IntentStatus.Pending),
  createdAt: zIsoDateTime,
}).strict();

export const zPreflightReport = z.object({
  status: z.enum([PreflightStatus.Running, PreflightStatus.Passed, PreflightStatus.Failed]),
  controlReady: z.boolean(),
  checks: z.object({
    api: z.enum(['pass', 'fail']),
    parentInterface: z.enum(['pass', 'fail']),
    nftables: z.enum(['pass', 'fail']),
    ipv4Filtering: z.enum(['pass', 'fail']),
    networkPrerequisites: z.enum(['pass', 'fail']),
    storagePool: z.enum(['pass', 'fail']),
    simplestreamsImage: z.enum(['pass', 'fail']),
    guestAddress: z.enum(['pass', 'fail']),
    nodeMetrics: z.enum(['pass', 'warn', 'fail']),
  }).strict(),
  failureCode: z.nativeEnum(FailureCode).nullable(),
  checkedAt: zIsoDateTime.nullable(),
  gpu: z.record(z.string(), z.unknown()).optional(),
}).strict().superRefine((report, context) => {
  if (report.controlReady && report.checks.networkPrerequisites !== 'pass') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['controlReady'],
      message: 'Control readiness requires network prerequisites',
    });
  }
});

export const zErrorResponse = z.object({
  statusCode: z.number().int().min(400).max(599),
  code: z.string().min(1).max(128),
  message: z.string().min(1).max(4_096),
  details: z.record(z.string(), z.unknown()).optional(),
  requestId: z.string().min(1).max(128),
}).strict();

// Settings requests.
export const zPatchSystemSettingsRequest = z.object({
  expectedRevision: zExpectedRevision,
  values: z.record(z.string(), z.unknown())
    .refine((values) => Object.keys(values).length > 0, 'At least one setting is required')
    .refine((values) => Object.keys(values).length <= 64, 'At most 64 settings may be updated at once'),
}).strict();

export type LoginRequest = z.infer<typeof zLoginRequest>;
export type RotateRefreshTokenRequest = z.infer<typeof zRotateRefreshTokenRequest>;
export type CreateUserRequest = z.infer<typeof zCreateUserRequest>;
export type UpdateUserRequest = z.infer<typeof zUpdateUserRequest>;
export type AddSshKeyRequest = z.infer<typeof zAddSshKeyRequest>;
export type ServerNetworkFields = z.infer<typeof zServerNetworkFields>;
export type CreateServerRequest = z.infer<typeof zCreateServerRequest>;
export type PatchServerRequest = z.infer<typeof zPatchServerRequest>;
export type RotateServerEnrollmentRequest = z.infer<typeof zRotateServerEnrollmentRequest>;
export type RunPreflightRequest = z.infer<typeof zRunPreflightRequest>;
export type PatchStoragePoolRequest = z.infer<typeof zPatchStoragePoolRequest>;
export type PatchSharedBackendExecutorRequest = z.infer<typeof zPatchSharedBackendExecutorRequest>;
export type DiscoverSharedExecutorsRequest = z.infer<typeof zDiscoverSharedExecutorsRequest>;
export type CreateSharedBackendRequest = z.infer<typeof zCreateSharedBackendRequest>;
export type PatchSharedBackendRequest = z.infer<typeof zPatchSharedBackendRequest>;
export type CreateIpPoolRequest = z.infer<typeof zCreateIpPoolRequest>;
export type PatchIpPoolRequest = z.infer<typeof zPatchIpPoolRequest>;
export type LocalVolumeScope = z.infer<typeof zLocalVolumeScope>;
export type SharedVolumeScope = z.infer<typeof zSharedVolumeScope>;
export type VolumeScope = z.infer<typeof zVolumeScope>;
export type ListSharedVolumesQuery = z.infer<typeof zListSharedVolumesQuery>;
export type StorageMountPreviewRequest = z.infer<typeof zStorageMountPreviewRequest>;
export type CreateContainerRequest = z.infer<typeof zCreateContainerRequest>;
export type PatchContainerLimitsRequest = z.infer<typeof zPatchContainerLimitsRequest>;
export type PatchContainerRootSizeRequest = z.infer<typeof zPatchContainerRootSizeRequest>;
export type PatchContainerNameRequest = z.infer<typeof zPatchContainerNameRequest>;
export type CreateExecSessionRequest = z.infer<typeof zCreateExecSessionRequest>;
export type AddCatalogImageRequest = z.infer<typeof zAddCatalogImageRequest>;
export type CreateImageRequest = z.infer<typeof zCreateImageRequest>;
export type PatchImageRequest = z.infer<typeof zPatchImageRequest>;
export type PutImageAssignmentRequest = z.infer<typeof zPutImageAssignmentRequest>;
export type GrantBundleQuotas = z.infer<typeof zGrantBundleQuotas>;
export type CreateGrantBundleRequest = z.infer<typeof zCreateGrantBundleRequest>;
export type PreviewGrantBundleRequest = z.infer<typeof zPreviewGrantBundleRequest>;
export type PatchGrantBundleRequest = z.infer<typeof zPatchGrantBundleRequest>;
export type ServerGrantOverrides = z.infer<typeof zServerGrantOverrides>;
export type PutServerGrantRequest = z.input<typeof zPutServerGrantRequest>;
export type PatchServerGrantRequest = z.infer<typeof zPatchServerGrantRequest>;
export type CreateDataDiskGrantRequest = z.infer<typeof zCreateDataDiskGrantRequest>;
export type PatchDataDiskGrantRequest = z.infer<typeof zPatchDataDiskGrantRequest>;
export type PutSharedBackendGrantRequest = z.infer<typeof zPutSharedBackendGrantRequest>;
export type IntentListQuery = z.infer<typeof zIntentListQuery>;
export type ListScope = z.infer<typeof zListScope>;
export type RetryIntentRequest = z.infer<typeof zRetryIntentRequest>;
export type NodeMetricsHealth = z.infer<typeof zNodeMetricsHealth>;
export type PreflightReport = z.infer<typeof zPreflightReport>;
export type ErrorResponse = z.infer<typeof zErrorResponse>;
export type PatchSystemSettingsRequest = z.infer<typeof zPatchSystemSettingsRequest>;
